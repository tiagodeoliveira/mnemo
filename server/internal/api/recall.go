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
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

type recallHandler struct {
	store  *store.Store
	logger *slog.Logger
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

	type req struct {
		dim    string
		prefix string
	}
	var reqs []req
	if q.Get("preferences") != "" {
		reqs = append(reqs, req{"preferences", "/preferences/" + actor + "/"})
	}
	if q.Get("facts") != "" {
		reqs = append(reqs, req{"facts", "/facts/" + actor + "/"})
	}
	if q.Get("episodes") != "" {
		reqs = append(reqs, req{"episodes", "/episodes/" + actor + "/"})
	}
	if q.Get("about") != "" {
		reqs = append(reqs, req{"about", "/about/" + actor + "/"})
	}
	if p := q.Get("project"); p != "" {
		reqs = append(reqs, req{"project", fmt.Sprintf("/projects/%s/%s/", actor, p)})
	}
	if t := q.Get("task"); t != "" {
		reqs = append(reqs, req{"task", fmt.Sprintf("/tasks/%s/%s/", actor, t)})
	}
	if d := q.Get("date"); d != "" {
		// Daily flag: both log entries and summary for that date.
		reqs = append(reqs,
			req{"daily_log", fmt.Sprintf("/daily/%s/%s/log/", actor, d)},
			req{"daily_summary", fmt.Sprintf("/daily/%s/%s/summary/", actor, d)},
		)
	} else if q.Get("daily") != "" {
		today := time.Now().UTC().Format("2006-01-02")
		reqs = append(reqs,
			req{"daily_log", fmt.Sprintf("/daily/%s/%s/log/", actor, today)},
			req{"daily_summary", fmt.Sprintf("/daily/%s/%s/summary/", actor, today)},
		)
	}
	if m := q.Get("meeting"); m != "" {
		reqs = append(reqs, req{"meeting", fmt.Sprintf("/meetings/%s/%s/", actor, m)})
	}

	if len(reqs) == 0 {
		w.WriteHeader(http.StatusOK)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte("{\"dimensions\":[]}"))
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
	_ = context.Background()
}
