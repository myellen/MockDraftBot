import React, { useMemo } from 'react';
import { marked } from 'marked';

// Configure marked for safe, inline-friendly rendering
marked.setOptions({
  breaks: true,    // GFM line breaks
  gfm: true,       // GitHub-flavored markdown (tables, strikethrough, etc.)
});

interface MarkdownProps {
  content: string;
}

export function Markdown({ content }: MarkdownProps) {
  const html = useMemo(() => {
    return marked.parse(content, { async: false }) as string;
  }, [content]);

  return (
    <div
      className="markdown-body"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
