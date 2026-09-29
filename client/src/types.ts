// 与后端 DTO 保持一致的前端类型。

export interface TextPos {
  line: number;
  column: number;
  offset: number;
}

export type IssueKind = 'duplicate_definition' | 'missing_reference';

export interface Issue {
  kind: IssueKind;
  number: number;
  message: string;
  start: number;
  end: number;
  pos: TextPos;
}

export interface DefinitionDTO {
  number: number;
  heading: string;
  headingLine: number;
  pos: TextPos;
  occurrenceCount: number;
}

export interface ReferenceDTO {
  number: number;
  pos: TextPos;
  line: string;
  targetDefined: boolean;
}

export interface AnalyzeDTO {
  totalOccurrences: number;
  definedNumbers: number[];
  definitions: DefinitionDTO[];
  references: ReferenceDTO[];
  issues: Issue[];
}

export interface DocumentDTO {
  id: number;
  title: string;
  content: string;
  /** 已保存正文的单调修订号：保存原文 / 提交改号 / 提交裁撤 / 撤销都会 +1 */
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface MappingEntry {
  from: number;
  to: number;
}

export interface ConflictError {
  code: string;
  message: string;
  from?: number;
  to?: number;
  positions?: TextPos[];
}

export interface ChangeItem {
  kind: 'definition' | 'reference';
  fromNumber: number;
  toNumber: number;
  before: string;
  after: string;
  line: number;
  column: number;
  snippet: string;
}

export interface PreviewResult {
  mapping: MappingEntry[];
  changeCount: number;
  changes: ChangeItem[];
  previewText: string;
  /** 预览所绑定的正文修订号 */
  revision: number;
  /** 一次性确认凭证：工作台确认改号必须回传；修改映射或正文修订号推进后即失效 */
  ticket: string;
}

export interface CommitResult {
  document: DocumentDTO;
  mapping: MappingEntry[];
  changeCount: number;
  changes: ChangeItem[];
  revision: number;
  analysis: AnalyzeDTO;
}

export interface UndoResult {
  document: DocumentDTO;
  undone: {
    op: 'renumber' | 'remove';
    mapping: MappingEntry[];
    deletes?: number[] | null;
    replacements?: RemovalReplacement[] | null;
    changeCount: number;
    createdAt: string;
  };
  analysis: AnalyzeDTO;
}

// ---------- 条款裁撤 ----------

export interface RemovalReplacement {
  from: number;
  to: number;
}

export interface DirectRefDTO {
  number: number;
  pos: TextPos;
  line: string;
  ownerNumber: number | null;
  ownerHeading: string | null;
  replacement?: number;
}

export interface ImpactedClauseDTO {
  number: number;
  heading: string;
  headingLine: number;
  direct: boolean;
  paths: number[][];
  directRefs: { number: number; pos: TextPos }[];
}

export interface DeletedClauseDTO {
  number: number;
  heading: string;
  headingLine: number;
  survivingRefCount: number;
  unreferenced: boolean;
}

export interface RemovalImpact {
  deletes: DeletedClauseDTO[];
  directReferences: DirectRefDTO[];
  impacted: ImpactedClauseDTO[];
  unreferenced: number[];
}

export interface NeighborHeadingDTO {
  number: number;
  heading: string;
  headingLine: number;
}

export interface RemovalBlock {
  number: number;
  heading: string;
  start: TextPos;
  end: TextPos;
  startLine: number;
  endLine: number;
  removedText: string;
  prev: NeighborHeadingDTO | null;
  next: NeighborHeadingDTO | null;
}

export interface RemovalChangeItem {
  kind: 'reference';
  fromNumber: number;
  toNumber: number;
  before: string;
  after: string;
  line: number;
  column: number;
  snippet: string;
  ownerNumber: number | null;
}

export interface RemovalPreviewResult {
  deletes: number[];
  replacements: RemovalReplacement[];
  deleteCount: number;
  blocks: RemovalBlock[];
  changes: RemovalChangeItem[];
  changeCount: number;
  impact: RemovalImpact;
  previewText: string;
}

export interface RemovalCommitResult {
  document: DocumentDTO;
  deletes: number[];
  replacements: RemovalReplacement[];
  deleteCount: number;
  blocks: RemovalBlock[];
  changes: RemovalChangeItem[];
  changeCount: number;
  analysis: AnalyzeDTO;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    conflicts?: ConflictError[];
  };
}

// ---------- 条款摘录（只读） ----------

export interface ExcerptRef {
  number: number;
  text: string;
  pos: TextPos;
  line: string;
}

export interface ExcerptClause {
  number: number;
  heading: string;
  headingLine: number;
  startLine: number;
  endLine: number;
  seed: boolean;
  text: string;
  references: ExcerptRef[];
}

export interface ExcerptResult {
  selected: number[];
  reached: number[];
  clauses: ExcerptClause[];
  text: string;
  count: number;
}

export interface ExcerptResponse {
  selected: number[];
  excerpt: ExcerptResult;
}

export interface ExcerptConflict {
  code:
    | 'EMPTY_SELECTION'
    | 'INVALID_NUMBER'
    | 'SELECTION_NOT_DEFINED'
    | 'DUPLICATE_DEFINITION'
    | 'MISSING_DEFINITION';
  message: string;
  number?: number;
  positions?: TextPos[];
  headings?: { number: number; heading: string; pos: TextPos }[];
  references?: { number: number; pos: TextPos; line: string; ownerNumber: number }[];
}

export interface ExcerptError {
  code: string;
  message: string;
  conflicts: ExcerptConflict[];
}

// ---------- 版本对照 ----------

export type DiffStatus = 'added' | 'removed' | 'modified' | 'renumbered' | 'unchanged';

export interface DiffClause {
  number: number;
  order: number;
  heading: string;
  headingLine: number;
  contentKey: string;
  snippet: string;
}

export interface DiffPair {
  status: DiffStatus;
  old: DiffClause | null;
  new: DiffClause | null;
}

export interface AmbiguousGroup {
  reason: 'duplicate_content' | 'duplicate_number';
  number: number | null;
  contentKey: string | null;
  message: string;
  old: DiffClause[];
  new: DiffClause[];
}

export interface DiffIssue {
  kind: IssueKind;
  number: number;
  message: string;
  line: number;
}

export interface VersionDiff {
  oldClauseCount: number;
  newClauseCount: number;
  pairs: DiffPair[];
  ambiguous: AmbiguousGroup[];
  oldIssues: DiffIssue[];
  newIssues: DiffIssue[];
  counts: Record<DiffStatus, number> & { ambiguous: number };
}

export interface VersionDiffResponse {
  diff: VersionDiff;
}
