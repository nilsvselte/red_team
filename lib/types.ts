export type Post = {
  id: string;
  title: string;
  body?: string;
  author?: string;
  url?: string;
  tags?: string[];
  type?: string;
};

export type CsvPost = Post & {
  model?: string;
  baseModel?: string;
  version?: string;
  hwNumber?: string;
  name?: string;
  titleRaw?: string;
  threadId?: string;
};

