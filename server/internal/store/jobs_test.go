package store

import (
	"context"
	"sync"
	"testing"
)

func TestClaimJobSkipLocked(t *testing.T) {
	dsn := startPG(t)
	s, _ := Open(context.Background(), dsn)
	defer func() { _ = s.Close() }()
	if err := s.Migrate(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	// Enqueue 10 jobs in one tx.
	tx, _ := s.DB.BeginTx(ctx, nil)
	for i := 0; i < 10; i++ {
		if err := s.EnqueueJob(ctx, tx, KindExtractContext, map[string]int{"n": i}); err != nil {
			t.Fatal(err)
		}
	}
	_ = tx.Commit()

	// 5 workers race to claim. Each job must be claimed by exactly one worker.
	var wg sync.WaitGroup
	claimed := make(chan int64, 100)
	for w := 0; w < 5; w++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for {
				j, err := s.ClaimJob(ctx, "w-"+string(rune('0'+id)))
				if err != nil {
					t.Errorf("claim: %v", err)
					return
				}
				if j == nil {
					return
				}
				claimed <- j.JobID
				_ = s.CompleteJob(ctx, j.JobID)
			}
		}(w)
	}
	wg.Wait()
	close(claimed)

	seen := map[int64]bool{}
	for id := range claimed {
		if seen[id] {
			t.Fatalf("job %d claimed twice", id)
		}
		seen[id] = true
	}
	if len(seen) != 10 {
		t.Fatalf("expected 10 distinct claims got %d", len(seen))
	}
}
