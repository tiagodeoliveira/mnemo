package queue

const MaxAttempts = 3

// BackoffSeconds returns the seconds to wait before the next attempt.
// Attempt count is 1-indexed (1 = first failure → wait 30s before retry).
func BackoffSeconds(attempts int) int {
	switch attempts {
	case 1:
		return 30
	case 2:
		return 120
	default:
		return 600
	}
}
