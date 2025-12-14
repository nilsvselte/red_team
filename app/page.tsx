import { fetchCsvPosts } from "@/lib/csvPosts";
import { buildAIPerspective, buildGroupedAIPerspective } from "@/lib/ai";
import Link from "next/link";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function first(searchParams: SearchParams | undefined, key: string): string | undefined {
  const value = searchParams?.[key];
  return Array.isArray(value) ? value[0] : value;
}

async function unwrapSearchParams(
  searchParams?: SearchParams | Promise<SearchParams>
): Promise<SearchParams | undefined> {
  return (searchParams as Promise<SearchParams> | undefined)?.then
    ? await (searchParams as Promise<SearchParams>)
    : (searchParams as SearchParams | undefined);
}

export default async function Home({
  searchParams,
}: {
  searchParams?: SearchParams | Promise<SearchParams>;
}) {
  const sp = await unwrapSearchParams(searchParams);
  const page = Math.max(1, Number(first(sp, "page") ?? "1"));
  const limit = Math.min(100, Math.max(10, Number(first(sp, "limit") ?? "25")));
  const query = (first(sp, "q") ?? "").trim();
  const view = (first(sp, "view") ?? "hw").trim(); // hw | model | posts

  const { threads: postsRaw, warning } = await fetchCsvPosts();
  const posts = dedupeById(postsRaw);

  const filtered = query ? posts.filter((post) => matchesQuery(post, query)) : posts;
  const totalPages = Math.max(1, Math.ceil(filtered.length / limit));
  const safePage = Math.min(page, totalPages);
  const pagePosts = filtered.slice((safePage - 1) * limit, safePage * limit);

  const overview = await buildAIPerspective(filtered);
  const grouped = await buildGroupedAIPerspective(filtered);

  const groups = view === "model" ? grouped.models : grouped.homeworks;
  const groupTitle = view === "model" ? "By model type" : "By homework";

  return (
    <main className="container">
      <header className="header">
        <h1>Special Participation A</h1>
        <p className="subtle">
          CSV-backed dashboard with AI summaries and group rollups (homework + model).
        </p>
        {warning ? <p className="notice">{warning}</p> : null}
      </header>

      <section className="card">
        <form className="controls" action="/" method="get">
          <input
            className="input"
            type="text"
            name="q"
            defaultValue={query}
            placeholder="Search title, author, text…"
            autoComplete="off"
          />
          <select className="select" name="view" defaultValue={view}>
            <option value="hw">Groups: homework</option>
            <option value="model">Groups: model</option>
            <option value="posts">All posts</option>
          </select>
          <select className="select" name="limit" defaultValue={String(limit)}>
            <option value="10">10 / page</option>
            <option value="25">25 / page</option>
            <option value="50">50 / page</option>
            <option value="100">100 / page</option>
          </select>
          <button className="button" type="submit">
            Apply
          </button>
        </form>
        <div className="meta">
          <span>
            Posts: <strong>{filtered.length}</strong>
          </span>
          <span>
            AI: <strong>{overview.mode}</strong> ({overview.modelUsed})
          </span>
          <span>
            Group AI: <strong>{grouped.mode}</strong> ({grouped.modelUsed})
          </span>
        </div>
      </section>

      <section className="card">
        <h2>AI overview</h2>
        <p className="prose">{overview.summary}</p>
        {overview.clusters.length ? (
          <ul className="bullets">
            {overview.clusters.slice(0, 5).map((cluster) => (
              <li key={cluster.title}>
                <strong>{cluster.title}:</strong> {cluster.description}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {view === "posts" ? (
        <section className="card">
          <h2>Posts</h2>
          <PostList posts={pagePosts} />
          <Pager page={safePage} totalPages={totalPages} limit={limit} query={query} view={view} />
        </section>
      ) : (
        <section className="card">
          <h2>{groupTitle}</h2>
          <div className="stack">
            {groups.length ? (
              groups.map((group) => (
                <details className="group" key={group.key}>
                  <summary>
                    <span className="groupTitle">{group.label}</span>
                    <span className="pill">{group.count}</span>
                  </summary>
                  <p className="prose subtle">{group.overview}</p>
                  <ul className="bullets">
                    {group.posts.slice(0, 20).map((post) => (
                      <li key={`${group.key}:${post.id}:${post.title}`}>
                        <Link href={`/thread/${post.id}`}>{post.title}</Link>
                        <span className="subtle"> — {post.takeaway}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ))
            ) : (
              <p className="subtle">No groups detected.</p>
            )}
          </div>
        </section>
      )}

      {view !== "posts" ? (
        <section className="card">
          <h2>Browse</h2>
          <PostList posts={pagePosts} />
          <Pager page={safePage} totalPages={totalPages} limit={limit} query={query} view={view} />
        </section>
      ) : null}
    </main>
  );
}

function dedupeById<T extends { id: unknown }>(threads: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const thread of threads) {
    const key = String(thread.id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(thread);
  }
  return out;
}

function matchesQuery(
  post: { title?: string; body?: string; author?: string; tags?: string[] },
  query: string
) {
  const q = query.toLowerCase();
  const haystack = [post.title ?? "", post.body ?? "", post.author ?? "", (post.tags ?? []).join(" ")]
    .join("\n")
    .toLowerCase();
  return haystack.includes(q);
}

function PostList({ posts }: { posts: Array<{ id: string; title: string; author?: string; url?: string; tags?: string[]; body?: string }> }) {
  return (
    <ul className="list">
      {posts.map((post) => {
        const hw = (post.tags ?? []).find((tag) => tag.toLowerCase().startsWith("hw:"))?.split(":")[1]?.trim();
        const model = (post.tags ?? []).find((tag) => tag.toLowerCase().startsWith("base_model:"))?.split(":")[1]?.trim();
        return (
          <li className="row" key={post.id}>
            <div className="rowMain">
              <Link className="rowTitle" href={`/thread/${post.id}`}>
                {post.title}
              </Link>
              <div className="rowMeta">
                {hw ? <span className="pill">HW {hw}</span> : null}
                {model ? <span className="pill">{model}</span> : null}
                {post.author ? <span className="subtle">{post.author}</span> : null}
                {post.url ? (
                  <Link className="subtle" href={post.url} target="_blank">
                    source
                  </Link>
                ) : null}
              </div>
              {post.body ? (
                <p className="subtle">
                  {post.body.slice(0, 180)}
                  {post.body.length > 180 ? "…" : ""}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Pager({
  page,
  totalPages,
  limit,
  query,
  view,
}: {
  page: number;
  totalPages: number;
  limit: number;
  query: string;
  view: string;
}) {
  const prev = page - 1;
  const next = page + 1;
  const base = `/?view=${encodeURIComponent(view)}&limit=${limit}${query ? `&q=${encodeURIComponent(query)}` : ""}`;
  return (
    <div className="pager">
      <span className="subtle">
        Page {page} / {totalPages}
      </span>
      <div className="pagerButtons">
        <Link className={`buttonLink ${page <= 1 ? "isDisabled" : ""}`} href={`${base}&page=${prev}`}>
          Prev
        </Link>
        <Link
          className={`buttonLink ${page >= totalPages ? "isDisabled" : ""}`}
          href={`${base}&page=${next}`}
        >
          Next
        </Link>
      </div>
    </div>
  );
}
