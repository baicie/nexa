# Todo List (Slice 4)

Minimal TSX Todo via `@nexa/ui` → Host:

- dynamic insert/remove (`For` + Host `remove`)
- Taffy Flexbox layout
- Scroll (clip + mouse wheel)

```bash
perry compile main.tsx -o todo
./todo
```

Add appends `Task N` (no TextInput in MVP). Toggle / Remove update the signal; list rows stay keyed by `id`.
