import {
  normalizeTag,
  rankRelationSuggestions,
  type ProducerSuggestionQuery,
  type RelationSuggestionDto,
  type SuggestionVocabulary,
  type TagSuggestionQuery,
} from '@t3/shared';
import type { T3Database } from '../database/connection.js';

type TagCandidateRow = {
  id: number;
  name: string;
  normalized_name: string;
  same_context_usage_count: number;
  total_usage_count: number;
};

type AliasRow = {
  canonical_normalized: string;
  alias_name: string;
};

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

function tagAliasScope(vocabulary: SuggestionVocabulary): string {
  return vocabulary === 'entry'
    ? "alias.vocabulary = 'entry'"
    : "alias.vocabulary = 'producer' AND alias.partition <> 'authors'";
}

function entryTagContext(
  input: TagSuggestionQuery,
): { sql: string; parameters: Array<string | number> } {
  const clauses: string[] = [];
  const parameters: Array<string | number> = [];
  if (input.entryType !== undefined) {
    clauses.push('entry.type = ?');
    parameters.push(input.entryType);
  }
  if (input.facetId !== undefined) {
    clauses.push('assignment.facet_id = ?');
    parameters.push(input.facetId);
  }
  if (clauses.length === 0) return { sql: '0', parameters };
  return {
    sql: `COUNT(DISTINCT CASE WHEN ${clauses.join(' AND ')} THEN assignment.entry_id END)`,
    parameters,
  };
}

function producerTagContext(
  input: TagSuggestionQuery,
): { sql: string; parameters: Array<string | number> } {
  if (input.entryType === undefined) return { sql: '0', parameters: [] };
  return {
    sql: `COUNT(DISTINCT CASE WHEN EXISTS (
      SELECT 1
      FROM entry_producers AS context_relation
      JOIN entries AS context_entry ON context_entry.id = context_relation.entry_id
      WHERE context_relation.producer_id = assignment.producer_id
        AND context_entry.type = ?
    ) THEN assignment.producer_id END)`,
    parameters: [input.entryType],
  };
}

function aliasesForTagCandidates(
  database: T3Database,
  vocabulary: SuggestionVocabulary,
  candidateRows: readonly TagCandidateRow[],
  query: string,
): Map<number, string[]> {
  if (candidateRows.length === 0) return new Map();
  const ids = candidateRows.map((row) => row.id);
  const rows = database.prepare(`
    SELECT tag.id AS tag_id, alias.alias_name
    FROM ${vocabulary === 'entry' ? 'tags' : 'producer_tags'} AS tag
    JOIN taxonomy_aliases AS alias
      ON alias.normalized_canonical = tag.normalized_name
     AND ${tagAliasScope(vocabulary)}
     AND alias.normalized_canonical <> ''
    WHERE tag.id IN (${placeholders(ids)})
      AND instr(alias.normalized_alias, ?) > 0
    ORDER BY alias.normalized_alias, alias.id
  `).all(...ids, query) as Array<{ tag_id: number; alias_name: string }>;
  const aliases = new Map<number, string[]>();
  for (const row of rows) {
    const values = aliases.get(row.tag_id) ?? [];
    values.push(row.alias_name);
    aliases.set(row.tag_id, values);
  }
  return aliases;
}

export function suggestTags(
  database: T3Database,
  input: TagSuggestionQuery,
): RelationSuggestionDto[] {
  const query = normalizeTag(input.q);
  if (query === '') return [];
  const exclusions = [...new Set(input.excludeIds)];
  const aliasScope = tagAliasScope(input.vocabulary);
  const exclusionSql = exclusions.length === 0
    ? ''
    : `AND tag.id NOT IN (${placeholders(exclusions)})`;

  const context = input.vocabulary === 'entry'
    ? entryTagContext(input)
    : producerTagContext(input);
  const table = input.vocabulary === 'entry' ? 'tags' : 'producer_tags';
  const assignmentTable = input.vocabulary === 'entry'
    ? 'entry_tags'
    : 'producer_tag_assignments';
  const assignmentTagColumn = 'tag_id';
  const totalSubjectColumn = input.vocabulary === 'entry' ? 'entry_id' : 'producer_id';
  const entryJoin = input.vocabulary === 'entry'
    ? 'LEFT JOIN entries AS entry ON entry.id = assignment.entry_id'
    : '';

  const rows = database.prepare(`
    SELECT
      tag.id,
      tag.name,
      tag.normalized_name,
      ${context.sql} AS same_context_usage_count,
      COUNT(DISTINCT assignment.${totalSubjectColumn}) AS total_usage_count
    FROM ${table} AS tag
    LEFT JOIN ${assignmentTable} AS assignment
      ON assignment.${assignmentTagColumn} = tag.id
    ${entryJoin}
    WHERE (
      instr(tag.normalized_name, ?) > 0
      OR EXISTS (
        SELECT 1
        FROM taxonomy_aliases AS alias
        WHERE alias.normalized_canonical = tag.normalized_name
          AND ${aliasScope}
          AND alias.normalized_canonical <> ''
          AND instr(alias.normalized_alias, ?) > 0
      )
    )
    ${exclusionSql}
    GROUP BY tag.id, tag.name, tag.normalized_name
  `).all(...context.parameters, query, query, ...exclusions) as TagCandidateRow[];

  const aliases = aliasesForTagCandidates(database, input.vocabulary, rows, query);
  return rankRelationSuggestions(rows.map((row) => ({
    id: row.id,
    name: row.name,
    aliases: aliases.get(row.id) ?? [],
    sameContextUsageCount: row.same_context_usage_count,
    totalUsageCount: row.total_usage_count,
  })), query, input.limit);
}

export function suggestProducers(
  database: T3Database,
  input: ProducerSuggestionQuery,
): RelationSuggestionDto[] {
  const query = normalizeTag(input.q);
  if (query === '') return [];
  const excluded = new Set(input.excludeIds);
  const aliasRows = database.prepare(`
    SELECT normalized_canonical AS canonical_normalized, alias_name
    FROM taxonomy_aliases
    WHERE vocabulary = 'producer'
      AND partition = 'authors'
      AND normalized_canonical <> ''
    ORDER BY normalized_alias, id
  `).all() as AliasRow[];
  const aliasesByCanonical = new Map<string, string[]>();
  for (const row of aliasRows) {
    const aliases = aliasesByCanonical.get(row.canonical_normalized) ?? [];
    aliases.push(row.alias_name);
    aliasesByCanonical.set(row.canonical_normalized, aliases);
  }

  const rows = database.prepare(`
    SELECT
      producer.id,
      producer.name,
      COUNT(DISTINCT relation.entry_id) AS total_usage_count
    FROM producers AS producer
    LEFT JOIN entry_producers AS relation ON relation.producer_id = producer.id
    GROUP BY producer.id, producer.name
  `).all() as Array<{ id: number; name: string; total_usage_count: number }>;

  return rankRelationSuggestions(rows
    .filter((row) => !excluded.has(row.id))
    .map((row) => ({
      id: row.id,
      name: row.name,
      aliases: aliasesByCanonical.get(normalizeTag(row.name)) ?? [],
      sameContextUsageCount: 0,
      totalUsageCount: row.total_usage_count,
    })), query, input.limit);
}
