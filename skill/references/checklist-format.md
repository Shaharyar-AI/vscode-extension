# CR-Track checklist format

Present fixable findings grouped by severity, highest first. Each finding is a
checkbox with a stable id, its category, a one-line title, and a `file:line`
location; put the description/suggestion on the following indented line, phrased
collaboratively. After fixable findings, render an "Annotations" section
(learning/praise) with NO checkboxes — they are report-only and can't be approved.

```
## CR-Track review — <N> files, <M> findings

### 🔴 Blocking (<count>)
- [ ] **f1 · [Security] SQL injection** — src/db.js:42
      Query built via string concatenation. Consider a parameterized query.

### 🟠 Important (<count>)
- [ ] **f2 · [Correctness] Unhandled promise rejection** — src/api.js:88

### 🔵 Nit (<count>)
- [ ] **f4 · [Docs] Missing docstring** — src/util.js:10

### 💡 Suggestion (<count>)
- [ ] **f6 · [Maintainability] Duplicated validation block** — src/forms.js:50

### 🌟 Annotations (learning / praise) (<count>)
- 🌟 **[Maintainability] Clean error handling** — src/api.js:20  (praise)
- 📚 **[Performance] Consider streaming here next time** — src/io.js:5  (learning)

Reply with the ids to apply (e.g. "f1 f3"), "all", "none",
or "dismiss <id> <reason>".
```

Rules:
- If a severity/annotation bucket is empty, omit its heading.
- If there are zero findings and zero annotations, say "CR-Track review — <N>
  files, no findings. Nice."
- Never apply any edit in this phase.
- Annotations are never approvable — if a reply names an annotation, ignore it;
  `all` approves fixable findings only.
