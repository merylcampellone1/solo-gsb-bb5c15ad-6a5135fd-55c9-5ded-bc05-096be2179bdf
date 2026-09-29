import type {
  AnalyzeDTO,
  ApiError,
  CommitResult,
  DocumentDTO,
  ExcerptResponse,
  PreviewResult,
  RemovalCommitResult,
  RemovalImpact,
  RemovalPreviewResult,
  RemovalReplacement,
  UndoResult,
  VersionDiff,
} from './types';

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const apiError = (data as ApiError | null)?.error;
    throw {
      code: apiError?.code ?? 'HTTP_ERROR',
      message: apiError?.message ?? `请求失败（${res.status}）`,
      conflicts: apiError?.conflicts ?? [],
    };
  }
  return data as T;
}

export interface AnalysisResponse {
  analysis: AnalyzeDTO;
}

export const api = {
  analyze(content: string) {
    return request<AnalysisResponse>('/api/analyze', {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
  },
  createDocument(title: string, content: string) {
    return request<{ document: DocumentDTO; analysis: AnalyzeDTO }>('/api/documents', {
      method: 'POST',
      body: JSON.stringify({ title, content }),
    });
  },
  getDocument(id: number) {
    return request<{ document: DocumentDTO; analysis: AnalyzeDTO }>(
      `/api/documents/${id}`,
    );
  },
  updateDocument(id: number, title: string, content: string) {
    return request<{ document: DocumentDTO; analysis: AnalyzeDTO }>(
      `/api/documents/${id}`,
      { method: 'PUT', body: JSON.stringify({ title, content }) },
    );
  },
  preview(id: number, mapping: { from: number; to: number }[]) {
    return request<PreviewResult>(`/api/documents/${id}/renumber/preview`, {
      method: 'POST',
      body: JSON.stringify({ mapping }),
    });
  },
  commit(id: number, mapping: { from: number; to: number }[]) {
    return request<CommitResult>(`/api/documents/${id}/renumber/commit`, {
      method: 'POST',
      body: JSON.stringify({ mapping }),
    });
  },
  undo(id: number) {
    return request<UndoResult>(`/api/documents/${id}/undo`, { method: 'POST' });
  },
  removalImpact(id: number, deletes: number[], replacements: RemovalReplacement[]) {
    return request<{ deletes: number[]; impact: RemovalImpact }>(
      `/api/documents/${id}/removal/impact`,
      { method: 'POST', body: JSON.stringify({ deletes, replacements }) },
    );
  },
  removalPreview(id: number, deletes: number[], replacements: RemovalReplacement[]) {
    return request<RemovalPreviewResult>(`/api/documents/${id}/removal/preview`, {
      method: 'POST',
      body: JSON.stringify({ deletes, replacements }),
    });
  },
  removalCommit(id: number, deletes: number[], replacements: RemovalReplacement[]) {
    return request<RemovalCommitResult>(`/api/documents/${id}/removal/commit`, {
      method: 'POST',
      body: JSON.stringify({ deletes, replacements }),
    });
  },
  exportUrl(id: number) {
    return `/api/documents/${id}/export`;
  },
  /** 版本对照（只读）：以已保存合同为旧稿，newContent 为粘贴的新稿 */
  versionDiff(id: number, newContent: string) {
    return request<{ diff: VersionDiff }>(`/api/documents/${id}/diff`, {
      method: 'POST',
      body: JSON.stringify({ newContent }),
    });
  },
  /** 条款摘录（只读）：勾选起点，沿正文引用递归收齐并输出纯文本 */
  excerpt(id: number, numbers: number[]) {
    return request<ExcerptResponse>(`/api/documents/${id}/excerpt`, {
      method: 'POST',
      body: JSON.stringify({ numbers }),
    });
  },
};
