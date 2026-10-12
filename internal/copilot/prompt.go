package copilot

import (
	"fmt"
	"strings"

	"github.com/Ranjith1605/humanSi.007/internal/rulebook"
)

// SystemPrompt builds the console's standing instructions from the Rule
// Book. Every fact in it is read from rulebook.json, so the console knows
// exactly what the site and the game teach and nothing invented alongside.
// It stays compact (ids, titles and the six questions, not the full
// articles) because small local models have small context windows and the
// pilot's own messages need room too.
func SystemPrompt(rb *rulebook.Rulebook) string {
	var b strings.Builder
	line := func(format string, args ...any) {
		fmt.Fprintf(&b, format, args...)
		b.WriteByte('\n')
	}

	ship := rb.Ship
	if ship == "" {
		ship = "the ship"
	}
	line("You are the SI console of the %s: an open-source language model running locally, here to help people learn and apply the %s Rule Book.", ship, rb.Title)
	line("You are SI (Super Intelligence in this Rule Book's terms), not a human. If asked, say so plainly.")
	b.WriteByte('\n')

	line("MISSION: %s", rb.Charter.Mission.Headline)
	b.WriteByte('\n')

	line("THE CHARTER: values and their articles (cite them by id).")
	for _, v := range rb.Charter.Values {
		parts := make([]string, 0, len(v.Articles))
		for _, a := range v.Articles {
			parts = append(parts, a.ID+" "+a.Title)
		}
		line("- %s: %s", v.Name, strings.Join(parts, "; "))
	}
	b.WriteByte('\n')

	name := rb.Method.Name
	if name == "" {
		name = "The Six Gates"
	}
	line("%s: before an SI system touches a real decision it passes these gates in order (cite gate and module ids).", strings.ToUpper(name))
	for _, m := range rb.Method.Modules {
		if m.Anchor != "" {
			line("- %s / %s %s: %s (anchor: %s)", m.Gate, m.ID, m.Name, m.Question, m.Anchor)
		} else {
			line("- %s / %s %s: %s", m.Gate, m.ID, m.Name, m.Question)
		}
	}
	if len(rb.Method.Verdicts) > 0 {
		parts := make([]string, 0, len(rb.Method.Verdicts))
		for _, v := range rb.Method.Verdicts {
			parts = append(parts, v.Label+": "+v.Meaning)
		}
		line("Every gate ends in a verdict. %s", strings.Join(parts, " "))
	}
	line("MINIMUM RULE: %s", rb.Method.MinimumRule.Text)
	b.WriteByte('\n')

	line("INTEGRITY RULES:")
	for _, r := range rb.Method.Integrity {
		line("- %s %s", r.ID, r.Title)
	}
	b.WriteByte('\n')

	line("DISCLAIMER: %s", rb.Disclaimer)
	b.WriteByte('\n')

	line("HOW TO ANSWER:")
	line("- Ground every answer in the Charter and the Six Gates, and cite the gate, module and article ids you rely on (for example G4, M4, H3, R6).")
	line("- When law comes up, say \"orientation, not legal advice\" and point to qualified counsel. Never state application dates of any law.")
	line("- If you are unsure, or the Rule Book does not cover the question, say so plainly. Never invent facts, numbers, sources or names.")
	line("- Be concise: a short answer, or a short list, in plain language.")
	return strings.TrimRight(b.String(), "\n")
}
