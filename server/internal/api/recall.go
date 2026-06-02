package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
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
	Namespace string       `json:"namespace"`
	Items     []recallItem `json:"items"`
}

type recallItem struct {
	ID              string    `json:"id"`
	Content         string    `json:"content"`
	Tags            []string  `json:"tags"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
	ReinforcedCount int       `json:"reinforced_count"`
	Similarity      float32   `json:"similarity,omitempty"`
}

type dimReq struct {
	dim    string
	prefix string
}

func (h *recallHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	actor := auth.ActorID(ctx)
	q := r.URL.Query()

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
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte("{\"dimensions\":[]}"))
		return
	}

	// Parse optional tag and time filters shared by both paths.
	var tags, tagsAll []string
	if tv := q.Get("tags"); tv != "" {
		tags = strings.Split(tv, ",")
	}
	if tm := q.Get("tag_mode"); tm == "all" && len(tags) > 0 {
		tagsAll = tags
		tags = nil
	}
	since, until, err := parseTimeRange(q.Get("since"), q.Get("until"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	limit := 0
	if lv := q.Get("limit"); lv != "" {
		n, err := strconv.Atoi(lv)
		if err != nil || n < 0 {
			http.Error(w, "limit must be a non-negative integer", http.StatusBadRequest)
			return
		}
		limit = n
	}

	// Check if semantic search is requested via ?q=
	queryText := q.Get("q")
	if queryText != "" {
		h.serveSemanticRecall(w, r, ctx, actor, reqs, queryText, q.Get("min_similarity"), limit)
		return
	}

	results := make([]dimGroup, len(reqs))
	errs := make([]error, len(reqs))
	var wg sync.WaitGroup
	for i, rq := range reqs {
		i, rq := i, rq
		wg.Add(1)
		go func() {
			defer wg.Done()
			mems, err := h.store.ListItems(ctx, store.ListItemsOpts{
				ActorID:         actor,
				NamespacePrefix: rq.prefix,
				Tags:            tags,
				TagsAll:         tagsAll,
				Since:           since,
				Until:           until,
				Limit:           limit,
			})
			if err != nil {
				h.logger.Warn("recall", "dim", rq.dim, "err", err)
				errs[i] = err
				return
			}
			items := make([]recallItem, len(mems))
			for j, m := range mems {
				items[j] = recallItem{
					ID:              m.ID.String(),
					Content:         m.Content,
					Tags:            m.Tags,
					CreatedAt:       m.CreatedAt,
					UpdatedAt:       m.UpdatedAt,
					ReinforcedCount: m.ReinforcedCount,
				}
			}
			results[i] = dimGroup{Dimension: rq.dim, Namespace: rq.prefix, Items: items}
		}()
	}
	wg.Wait()

	for _, e := range errs {
		if e != nil {
			http.Error(w, "recall failed", http.StatusInternalServerError)
			return
		}
	}

	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"dimensions": results})
}


// defaultSemanticMinSimilarity is applied when the caller passes ?q= without
// an explicit min_similarity. Embedding scores below ~0.20 are essentially
// random topical noise in this corpus, and dropping them keeps recall focused.
const defaultSemanticMinSimilarity float32 = 0.20

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
	limit int,
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

	minSim := defaultSemanticMinSimilarity
	if minSimilarityStr != "" {
		var f float64
		if _, err := fmt.Sscanf(minSimilarityStr, "%f", &f); err == nil {
			minSim = float32(f)
		}
	}

	semanticLimit := limit
	if semanticLimit <= 0 {
		semanticLimit = 100
	}

	results := make([]dimGroup, len(reqs))
	errs := make([]error, len(reqs))
	var wg sync.WaitGroup
	for i, rq := range reqs {
		i, rq := i, rq
		wg.Add(1)
		go func() {
			defer wg.Done()
			hits, err := h.store.SemanticSearch(ctx, store.SearchOpts{
				ActorID:         actor,
				QueryText:       queryText,
				QueryEmbedding:  queryEmbedding,
				Dimensions:      []string{rq.dim},
				NamespacePrefix: rq.prefix,
				Limit:           semanticLimit,
				MinSimilarity:   minSim,
			})
			if err != nil {
				h.logger.Warn("semantic recall", "dim", rq.dim, "err", err)
				errs[i] = err
				return
			}
			items := make([]recallItem, len(hits))
			for j, hit := range hits {
				items[j] = recallItem{
					ID:              hit.ID.String(),
					Content:         hit.Content,
					Tags:            hit.Tags,
					CreatedAt:       hit.CreatedAt,
					UpdatedAt:       hit.UpdatedAt,
					ReinforcedCount: hit.ReinforcedCount,
					Similarity:      hit.Similarity,
				}
			}
			results[i] = dimGroup{Dimension: rq.dim, Namespace: rq.prefix, Items: items}
		}()
	}
	wg.Wait()

	for _, e := range errs {
		if e != nil {
			http.Error(w, "recall failed", http.StatusInternalServerError)
			return
		}
	}

	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"dimensions": results})
}
