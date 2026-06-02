package store

import (
	"encoding/json"
	"testing"
)

func TestTagsToJSON_RoundTrips(t *testing.T) {
	cases := []struct {
		name string
		tags []string
	}{
		{"nil", nil},
		{"empty", []string{}},
		{"simple", []string{"language", "tool"}},
		{"single", []string{"architecture"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b := tagsToJSON(tc.tags)
			var got []string
			if err := json.Unmarshal(b, &got); err != nil {
				t.Fatalf("unmarshal %q: %v", b, err)
			}
			if len(tc.tags) == 0 {
				if len(got) != 0 {
					t.Fatalf("expected empty, got %v", got)
				}
				return
			}
			if len(got) != len(tc.tags) {
				t.Fatalf("len: want %d, got %d", len(tc.tags), len(got))
			}
			for i := range tc.tags {
				if got[i] != tc.tags[i] {
					t.Errorf("[%d]: want %q, got %q", i, tc.tags[i], got[i])
				}
			}
		})
	}
}

func TestTagsToJSON_SpecialCharacters(t *testing.T) {
	// This is the core regression: tags containing JSON-special characters
	// must be escaped. The old hand-rolled serializer produced invalid JSON.
	cases := []struct {
		name string
		tags []string
	}{
		{"double quote", []string{`say "hello"`}},
		{"backslash", []string{`path\to\file`}},
		{"newline", []string{"line1\nline2"}},
		{"tab", []string{"col1\tcol2"}},
		{"unicode", []string{"日本語", "émoji 🎉"}},
		{"mixed special", []string{`a "b" c\d`, "e\nf", "normal"}},
		{"control char", []string{string([]byte{0x00, 0x1f})}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b := tagsToJSON(tc.tags)

			// Must be valid JSON.
			var got []string
			if err := json.Unmarshal(b, &got); err != nil {
				t.Fatalf("produced invalid JSON %q: %v", b, err)
			}

			// Must round-trip exactly.
			if len(got) != len(tc.tags) {
				t.Fatalf("len: want %d, got %d", len(tc.tags), len(got))
			}
			for i := range tc.tags {
				if got[i] != tc.tags[i] {
					t.Errorf("[%d]: want %q, got %q", i, tc.tags[i], got[i])
				}
			}
		})
	}
}
