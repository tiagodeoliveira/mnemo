package api

import (
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/tiagodeoliveira/mnemo/server/internal/auth"
	"github.com/tiagodeoliveira/mnemo/server/internal/embed"
	"github.com/tiagodeoliveira/mnemo/server/internal/store"
)

type searchRequest struct {
	Q               string   `json:"q"`
	Dimensions      []string `json:"dimensions"`
	Tags            []string `json:"tags"`
	TagMode         string   `json:"tag_mode"` // "any" (default) or "all"
	NamespacePrefix string   `json:"namespace_prefix"`
	Since           string   `json:"since"`
	Until           string   `json:"until"`
	Limit           int      `json:"limit"`
	MinSimilarity   float32  `json:"min_similarity"`
}

type searchResponseItem struct {
	ID              string    `json:"id"`
	Dimension       string    `json:"dimension"`
	Namespace       string    `json:"namespace"`
	Content         string    `json:"content"`
	Tags            []string  `json:"tags"`
	Similarity      float32   `json:"similarity"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
	ReinforcedCount int       `json:"reinforced_count"`
}

type searchResponse struct {
	Results              []searchResponseItem `json:"results"`
	QueryEmbedTokensUsed int                 `json:"query_embedding_cost_tokens"`
}

type searchHandler struct {
	store         *store.Store
	embedClient   embed.Client
	embedDisabled bool
	logger        *slog.Logger
}

func (h *searchHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.embedDisabled {
		http.Error(w, "semantic search disabled", http.StatusServiceUnavailable)
		return
	}
	var req searchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if req.Q == "" {
		http.Error(w, "q required", http.StatusBadRequest)
		return
	}

	// Embed the query.
	emb, err := h.embedClient.Embed(r.Context(), embed.EmbedRequest{Texts: []string{req.Q}})
	if err != nil {
		h.logger.Warn("embed query", "err", err)
		http.Error(w, "embed failed", http.StatusBadGateway)
		return
	}

	actor := auth.ActorID(r.Context())
	opts := store.SearchOpts{
		ActorID:         actor,
		QueryEmbedding:  emb.Vectors[0],
		Dimensions:      req.Dimensions,
		NamespacePrefix: req.NamespacePrefix,
		Limit:           req.Limit,
		MinSimilarity:   req.MinSimilarity,
	}

	// Tag filter dispatch.
	if req.TagMode == "all" {
		opts.TagsAll = req.Tags
	} else {
		opts.Tags = req.Tags
	}

	// Parse since/until — accept RFC3339 or date-only YYYY-MM-DD.
	opts.Since, opts.Until = parseTimeRange(req.Since, req.Until)

	hits, err := h.store.SemanticSearch(r.Context(), opts)
	if err != nil {
		h.logger.Error("search", "err", err)
		http.Error(w, "search failed", http.StatusInternalServerError)
		return
	}

	out := searchResponse{
		Results:              make([]searchResponseItem, len(hits)),
		QueryEmbedTokensUsed: emb.TokensUsed,
	}
	for i, hit := range hits {
		out.Results[i] = searchResponseItem{
			ID:              hit.ID.String(),
			Dimension:       hit.Dimension,
			Namespace:       hit.Namespace,
			Content:         hit.Content,
			Tags:            hit.Tags,
			Similarity:      hit.Similarity,
			CreatedAt:       hit.CreatedAt,
			UpdatedAt:       hit.UpdatedAt,
			ReinforcedCount: hit.ReinforcedCount,
		}
	}
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

// parseTimeRange parses since/until strings accepting RFC3339 or YYYY-MM-DD.
func parseTimeRange(since, until string) (sql.NullTime, sql.NullTime) {
	parse := func(s string) sql.NullTime {
		if s == "" {
			return sql.NullTime{}
		}
		for _, layout := range []string{time.RFC3339, "2006-01-02"} {
			if t, err := time.Parse(layout, s); err == nil {
				return sql.NullTime{Time: t, Valid: true}
			}
		}
		return sql.NullTime{}
	}
	return parse(since), parse(until)
}
