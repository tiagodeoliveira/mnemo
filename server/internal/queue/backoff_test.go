package queue

import "testing"

func TestBackoffSeconds(t *testing.T) {
	for _, c := range []struct{ in, want int }{{1, 30}, {2, 120}, {3, 600}, {99, 600}} {
		if got := BackoffSeconds(c.in); got != c.want {
			t.Errorf("BackoffSeconds(%d) = %d, want %d", c.in, got, c.want)
		}
	}
}
