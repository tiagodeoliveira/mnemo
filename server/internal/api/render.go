package api

import (
	"encoding/json"
	"fmt"
	"strings"
)

// renderMarkdown produces a markdown blob matching today's CLI output shape.
func renderMarkdown(groups []dimGroup) string {
	var b strings.Builder
	b.WriteString("{\"markdown\":")
	var md strings.Builder
	for _, g := range groups {
		if len(g.Items) == 0 {
			continue
		}
		fmt.Fprintf(&md, "## %s\n\n", g.Dimension)
		for _, it := range g.Items {
			fmt.Fprintf(&md, "- %s\n", it.Content)
		}
		md.WriteString("\n")
	}
	js, _ := json.Marshal(md.String())
	b.Write(js)
	b.WriteString("}")
	return b.String()
}
