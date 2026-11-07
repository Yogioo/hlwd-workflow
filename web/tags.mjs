// 标签库：配置只存「颜色 / 说明 / 归档」，实际使用仍从 beads 读。
// 改名会级联到历史工单：先加新标签，再去掉旧标签，失败时至少旧标签还在。
import { readProjectConfig, saveProjectConfig, tagColor, tagName } from '../project.mjs';
import * as beads from './beads.mjs';

const countOf = (labels, name) => labels.find((l) => l.name === name)?.count ?? 0;

function entryOf(cfg, name) {
  return (cfg.tags ?? []).find((t) => t.name === name) ?? null;
}

function viewOf(tag, count, cfg, { system = false, unregistered = false } = {}) {
  return {
    name: tag.name,
    color: tag.color ?? '',
    desc: tag.desc ?? '',
    archived: tag.archived === true,
    count,
    system,
    unregistered,
  };
}

/** 目录 + 真实使用数合并。没登记但已经在用的标签也要列出来，不能让它消失。 */
export async function listTags(projectDir) {
  const cfg = await readProjectConfig(projectDir);
  const labels = await beads.listLabels();
  const seen = new Set();
  const out = [];

  const ready = cfg.engine.readyLabel;
  if (ready) {
    const entry = entryOf(cfg, ready) ?? { name: ready, color: '', desc: '可派给 AI 的标签', archived: false };
    seen.add(ready);
    out.push(viewOf(entry, countOf(labels, ready), cfg, { system: true }));
  }

  for (const tag of cfg.tags ?? []) {
    if (seen.has(tag.name)) continue;
    seen.add(tag.name);
    out.push(viewOf(tag, countOf(labels, tag.name), cfg, { system: tag.name === ready }));
  }

  for (const label of labels) {
    if (seen.has(label.name)) continue;
    seen.add(label.name);
    out.push(viewOf({ name: label.name, color: '', desc: '', archived: false }, label.count, cfg, { unregistered: true }));
  }

  return out;
}

export async function createTag(projectDir, input = {}) {
  const cfg = await readProjectConfig(projectDir);
  const name = tagName(input.name);
  if (name === cfg.engine.readyLabel) throw new Error('可派标签是系统标签，不能重复登记');
  if (entryOf(cfg, name)) throw new Error(`标签「${name}」已经在库里了`);
  if ((cfg.tags ?? []).length >= 200) throw new Error('标签最多 200 个');
  const tag = { name, color: tagColor(input.color), desc: String(input.desc ?? '').trim().slice(0, 200), archived: false };
  await saveProjectConfig(projectDir, { tags: [...(cfg.tags ?? []), tag] });
  return listTags(projectDir);
}

/**
 * 改名 / 改色 / 改说明 / 归档。改名会级联到所有带这个标签的工单。
 * @returns {{tags: object[], affected: number, oldName: string, name: string}}
 */
export async function updateTag(projectDir, currentName, input = {}, { actor } = {}) {
  const cfg = await readProjectConfig(projectDir);
  const current = tagName(currentName);
  const entry = entryOf(cfg, current) ?? { name: current, color: '', desc: '', archived: false };
  const nextName = input.name !== undefined ? tagName(input.name) : current;
  const isReady = current === cfg.engine.readyLabel;
  const archived = input.archived === undefined ? entry.archived : Boolean(input.archived);
  const nextEntry = {
    ...entry,
    name: nextName,
    color: input.color === undefined ? entry.color : tagColor(input.color),
    desc:
      input.desc === undefined
        ? entry.desc || (isReady ? '可派给 AI 的标签' : '')
        : String(input.desc).trim().slice(0, 200),
    archived,
  };
  if (isReady && archived) throw new Error('可派标签不能归档：engine 靠它接单');

  if (nextName !== current) {
    if (entryOf(cfg, nextName)) throw new Error(`标签「${nextName}」已经存在，不能重名`);
    const used = await beads.listLabels();
    if (used.some((l) => l.name === nextName)) throw new Error(`标签「${nextName}」已经被工单使用，先合并再加`);
    const affected = await beads.listIssues({ label: current, all: true, limit: 1000 });
    const ids = affected.map((i) => i.id);
    // 先加新，再落目录，最后去旧：中途失败时旧标签还在，不会把工单变成无标签。
    await beads.addLabelToIssues(ids, nextName, { actor });
    if (isReady) cfg.engine.readyLabel = nextName;
    const tags = (cfg.tags ?? []).map((t) => (t.name === current ? nextEntry : t));
    if (!entryOf(cfg, current)) tags.push(nextEntry);
    await saveProjectConfig(projectDir, {
      tags,
      ...(isReady ? { engine: { readyLabel: nextName } } : {}),
    });
    await beads.removeLabelFromIssues(ids, current, { actor });
    return { tags: await listTags(projectDir), affected: affected.length, oldName: current, name: nextName };
  }

  const tags = (cfg.tags ?? []).some((t) => t.name === current)
    ? (cfg.tags ?? []).map((t) => (t.name === current ? nextEntry : t))
    : [...(cfg.tags ?? []), nextEntry];
  await saveProjectConfig(projectDir, { tags });
  return { tags: await listTags(projectDir), affected: 0, oldName: current, name: current };
}

/**
 * 删除：默认只从目录里移除（已有工单仍保留标签）；
 * purge=true 时连历史工单上的标签一起摘掉。
 */
export async function deleteTag(projectDir, currentName, { purge = false, actor } = {}) {
  const cfg = await readProjectConfig(projectDir);
  const name = tagName(currentName);
  if (name === cfg.engine.readyLabel) throw new Error('可派标签不能删除：engine 靠它接单');
  let affected = 0;
  if (purge) {
    const used = await beads.listIssues({ label: name, all: true, limit: 1000 });
    affected = used.length;
    await beads.removeLabelFromIssues(used.map((i) => i.id), name, { actor });
  }
  await saveProjectConfig(projectDir, { tags: (cfg.tags ?? []).filter((t) => t.name !== name) });
  return { tags: await listTags(projectDir), affected };
}
