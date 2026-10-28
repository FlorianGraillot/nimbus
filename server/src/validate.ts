import type { ZodType } from 'zod';
import { HttpError } from './access.js';

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path?.join('.');
    throw new HttpError(400, issue ? `${path ? `${path}: ` : ''}${issue.message}` : 'Invalid request');
  }
  return result.data;
}

export const AVATAR_COLORS = [
  '#6d5efc',
  '#f47fff',
  '#00a8fc',
  '#23a55a',
  '#f0b232',
  '#f23f43',
  '#eb459e',
  '#3ba55c',
  '#faa61a',
  '#9b59b6',
];
