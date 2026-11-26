'use strict';
/**
 * handoff.js —— 跨 agent「交接契约」的压缩与校验层（零依赖）
 *
 * 问题：旧做法把上游 result.md 整段拼进下游 prompt。链一长，下游 prompt 体积线性膨胀，
 *      token 成本失控（多 agent 本来就是 15× 量级），且上游的元信息（role/worker/ok）噪声很大。
 *
 * 做法：把上游产物压成结构化交接块
 *      【上游交接】来源步骤 / 交接指纹 / 上游摘要 / 上游内容(可截断)
 *      并用「交接指纹」证明上游确实被带进了下游 —— 这样即使内容被截断，
 *      完整性校验依然成立（校验的是"确实交接了"，而不是"整段原文一字不差"）。
 */
const crypto = require('crypto');

/** 解析 result.md → { summary, body }（与 core.parseResultMd 同结构） */
function parseResult(md) {
  md = String(md || '');
  const headEnd = md.indexOf('## Summary');
  const summary = headEnd >= 0 ? String(md.slice(headEnd + '## Summary'.length).split('## Output')[0] || '').trim() : '';
  const body = String(md.split('## Output')[1] || '').trim();
  return { summary, body };
}

/**
 * 构建交接块
 * @param {string} from        上游步骤 id
 * @param {string} resultMd    上游 result.md 全文
 * @param {object} opts        { maxChars, sourcePath }
 */
function build(from, resultMd, opts = {}) {
  const maxChars = Number(opts.maxChars || process.env.RELAY_HANDOFF_MAX || 4000);
  const { summary, body } = parseResult(resultMd);
  const fingerprint = crypto
    .createHash('sha1')
    .update(String(from || '') + '|' + summary.slice(0, 400) + '|' + body.slice(0, 400))
    .digest('hex')
    .slice(0, 10);
  const truncated = body.length > maxChars;
  const content = truncated
    ? body.slice(0, maxChars) + '\n…（上游内容已截断，完整版见 ' + (opts.sourcePath || '上游 result.md') + '）'
    : body;
  const block = [
    '【上游交接】',
    '- 来源步骤: ' + from,
    '- 交接指纹: ' + fingerprint,
    '- 上游摘要: ' + (summary ? summary.slice(0, 300) : '(无)'),
    '- 上游内容' + (truncated ? '（已截断至 ' + maxChars + ' 字）' : '') + ':',
    content || '(空)',
  ].join('\n');
  return { block, fingerprint, truncated, chars: content.length, total_chars: body.length, summary };
}

/** 下游契约里是否真带着该指纹（交接完整性校验） */
function verify(taskJsonText, handoff) {
  if (!handoff || !handoff.fingerprint) return true;
  return String(taskJsonText || '').includes(handoff.fingerprint);
}

module.exports = { build, parseResult, verify };
