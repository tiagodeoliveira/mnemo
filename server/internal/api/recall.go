package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/tiagodeoliveira/mnemo/server/internal/auth"
	"github.com/tiagodeoliveira/mnemo/server/internal/embed"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

type recallHandler struct {
	store         *store.Store
	embedClient   embed.Client
	embedDisabled bool
	logger        *slog.Logger
}

type dimGroup struct {
	Dimension string       `json:"dimension"`
	Items     []recallItem `json:"items"`
}
type recallItem struct {
	ID         string          `json:"id"`
	Namespace  string          `json:"namespace"`
	Content    string          `json:"content"`
	Attributes json.RawMessage `json:"attributes"`
	UpdatedAt  time.Time       `json:"updated_at"`
	Similarity float32         `json:"similarity,omitempty"`
}

type dimReq struct {
	dim    string
	prefix string
}

func (h *recallHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actor := auth.ActorID(ctx)
	q := r.URL.Query()

	attrFilters := map[string]string{}
	for k, v := range q {
		if strings.HasPrefix(k, "attr.") && len(v) > 0 {
			attrFilters[strings.TrimPrefix(k, "attr.")] = v[0]
		}
	}

	var reqs []dimReq
	if q.Get("preferences") != "" {
		reqs = append(reqs, dimReq{"preferences", "/preferences/" + actor + "/"})
	}
	if q.Get("episodes") != "" {
		reqs = append(reqs, dimReq{"episodes", "/episodes/" + actor + "/"})
	}
	if q.Get("about") != "" {
		reqs = append(reqs, dimReq{"about", "/about/" + actor + "/"})
	}
	if p := q.Get("project"); p != "" {
		reqs = append(reqs, dimReq{"project", fmt.Sprintf("/projects/%s/%s/", actor, p)})
	}
	if t := q.Get("task"); t != "" {
		reqs = append(reqs, dimReq{"task", fmt.Sprintf("/tasks/%s/%s/", actor, t)})
	}
	if d := q.Get("date"); d != "" {
		// Daily flag: both log entries and summary for that date.
		reqs = append(reqs,
			dimReq{"daily_log", fmt.Sprintf("/daily/%s/%s/log/", actor, d)},
			dimReq{"daily_summary", fmt.Sprintf("/daily/%s/%s/summary/", actor, d)},
		)
	} else if q.Get("daily") != "" {
		today := time.Now().UTC().Format("2006-01-02")
		reqs = append(reqs,
			dimReq{"daily_log", fmt.Sprintf("/daily/%s/%s/log/", actor, today)},
			dimReq{"daily_summary", fmt.Sprintf("/daily/%s/%s/summary/", actor, today)},
		)
	}
	if m := q.Get("meeting"); m != "" {
		reqs = append(reqs, dimReq{"meeting", fmt.Sprintf("/meetings/%s/%s/", actor, m)})
	}

	if len(reqs) == 0 {
		w.WriteHeader(http.StatusOK)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte("{\"dimensions\":[]}"))
		return
	}

	// Check if semantic search is requested via ?q=
	queryText := q.Get("q")
	if queryText != "" {
		h.serveSemanticRecall(w, r, ctx, actor, reqs, queryText, q.Get("min_similarity"))
		return
	}

	results := make([]dimGroup, len(reqs))
	var wg sync.WaitGroup
	for i, rq := range reqs {
		i, rq := i, rq
		wg.Add(1)
		go func() {
			defer wg.Done()
			mems, err := h.store.QueryByPrefix(ctx, store.RecallFilter{
				ActorID: actor, NamespacePref: rq.prefix, AttrFilters: attrFilters,
			})
			if err != nil {
				h.logger.Warn("recall", "dim", rq.dim, "err", err)
				return
			}
			items := make([]recallItem, len(mems))
			for j, m := range mems {
				items[j] = recallItem{ID: m.ID.String(), Namespace: m.Namespace, Content: m.Content, Attributes: m.Attributes, UpdatedAt: m.UpdatedAt}
			}
			results[i] = dimGroup{Dimension: rq.dim, Items: items}
		}()
	}
	wg.Wait()

	visible := q.Get("visible") != "false"
	w.Header().Set("content-type", "application/json")
	if visible {
		_, _ = w.Write([]byte(renderMarkdown(results)))
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"dimensions": results})
}


// serveSemanticRecall handles ?q= queries: embeds the query and uses cosine
// similarity ordering within each requested dimension/namespace.
func (h *recallHandler) serveSemanticRecall(
	w http.ResponseWriter,
	r *http.Request,
	ctx context.Context,
	actor string,
	reqs []dimReq,
	queryText string,
	minSimilarityStr string,
) {
	if h.embedDisabled || h.embedClient == nil {
		http.Error(w, "semantic search disabled (q param requires embeddings)", http.StatusServiceUnavailable)
		return
	}
	emb, err := h.embedClient.Embed(ctx, embed.EmbedRequest{Texts: []string{queryText}})
	if err != nil {
		h.logger.Warn("embed recall query", "err", err)
		http.Error(w, "embed failed", http.StatusBadGateway)
		return
	}
	queryEmbedding := emb.Vectors[0]

	var minSim float32
	if minSimilarityStr != "" {
		var f float64
		if _, err := fmt.Sscanf(minSimilarityStr, "%f", &f); err == nil {
			minSim = float32(f)
		}
	}

	results := make([]dimGroup, len(reqs))
	var wg sync.WaitGroup
	for i, rq := range reqs {
		i, rq := i, rq
		wg.Add(1)
		go func() {
			defer wg.Done()
			hits, err := h.store.SemanticSearch(ctx, store.SearchOpts{
				ActorID:         actor,
				QueryEmbedding:  queryEmbedding,
				Dimensions:      []string{rq.dim},
				NamespacePrefix: rq.prefix,
				Limit:           100,
				MinSimilarity:   minSim,
			})
			if err != nil {
				h.logger.Warn("semantic recall", "dim", rq.dim, "err", err)
				return
			}
			items := make([]recallItem, len(hits))
			for j, hit := range hits {
				items[j] = recallItem{
					ID:        hit.ID.String(),
					Namespace: hit.Namespace,
					Content:   hit.Content,
					UpdatedAt: hit.UpdatedAt,
					Similarity: hit.Similarity,
				}
			}
			results[i] = dimGroup{Dimension: rq.dim, Items: items}
		}()
	}
	wg.Wait()

	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"dimensions": results})
}
