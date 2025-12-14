import { fetchCsvPostById } from "@/lib/csvPosts";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function ThreadPage({ params }: { params: { id: string } }) {
  const { thread, source, warning } = await fetchCsvPostById(params.id);

  return (
    <main className="container">
      <header className="header">
        <div className="topbar">
          <Link className="buttonLink" href="/">
            ← Back
          </Link>
          <span className="subtle">Source: {source}</span>
          {thread?.url ? (
            <Link className="buttonLink" href={thread.url} target="_blank">
              Open source
            </Link>
          ) : null}
        </div>
        <h1>{thread?.title ?? "Post not found"}</h1>
        {thread?.author ? <p className="subtle">By {thread.author}</p> : null}
        {warning ? <p className="notice">{warning}</p> : null}
      </header>

      <section className="card">
        <h2>Content</h2>
        <div className="content">{thread?.body || "No content available."}</div>
      </section>

      {thread?.tags?.length ? (
        <section className="card">
          <h2>Tags</h2>
          <div className="tagRow">
            {thread.tags.map((tag) => (
              <span className="pill" key={tag}>
                {tag}
              </span>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
