/** 读取 tests/fixtures 下的真实抓包数据（单元/集成测试共用）。 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const FIXTURES = path.resolve(import.meta.dirname);

/** @returns {Promise<Buffer>} */
export function fixtureBuffer(rel) {
  return readFile(path.join(FIXTURES, rel));
}

/** @returns {Promise<string>} */
export async function fixtureText(rel) {
  return (await fixtureBuffer(rel)).toString('utf8');
}

/** @returns {Promise<any>} */
export async function fixtureJson(rel) {
  return JSON.parse(await fixtureText(rel));
}
