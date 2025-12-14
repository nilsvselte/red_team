AI-led dashboard that renders Special Participation posts from a local CSV (`special_participation_a.csv`) and produces HW/model rollups (with optional LLM summaries).

## Getting Started

### 1) Configure environment

Create/edit `.env.local` and set:

- `OPENAI_API_KEY` (optional; enables LLM group summaries + per-post takeaways)
- Optional: `CSV_PATH` (defaults to `./special_participation_a.csv`)
- Optional: `AI_GROUP_MAX` (how many HW/model groups to LLM-summarize; default `8`)

### 2) Run the dev server

Run:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Usage

- Home dashboard: `http://localhost:3000`
- Switch views: `/?view=hw`, `/?view=model`, `/?view=posts`
- Thread detail page: `http://localhost:3000/thread/<id>`

## Notes

- `special_participation_a.csv` is the source of truth; the app reads it server-side on each request.
- Secrets should never be committed; `.env.local` is gitignored.
