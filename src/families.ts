import path from "node:path";
import type { AnalyzerLocation } from "@kongyo2/similarity-ts";
import { FRAGMENT_KIND, overlaps } from "./fallow.ts";
import type { Family, JudgedPair, Shape } from "./types.ts";

export const SHAPE_LABELS: Record<Shape, string> = { remove_copy: "copy", derive: "derive", extract_shared: "extract" };

function sameMember(a: AnalyzerLocation, b: AnalyzerLocation): boolean {
  if (a.kind !== FRAGMENT_KIND && b.kind !== FRAGMENT_KIND) {
    return path.resolve(a.filePath) === path.resolve(b.filePath) && a.startLine === b.startLine && a.endLine === b.endLine;
  }
  return overlaps(a, b);
}

export function groupFamilies(pairs: JudgedPair[]): Family[] {
  const parent = new Map<string, string>();
  const locations = new Map<string, AnalyzerLocation>();
  const byFile = new Map<string, string[]>();
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let current = key;
    while (parent.get(current) !== root) {
      const next = parent.get(current)!;
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  const add = (location: AnalyzerLocation): string => {
    const file = path.resolve(location.filePath);
    const known = (byFile.get(file) ?? []).find((key) => sameMember(locations.get(key)!, location));
    if (known !== undefined) return known;
    const key = `${file}:${location.startLine}-${location.endLine}`;
    parent.set(key, key);
    locations.set(key, location);
    byFile.set(file, [...(byFile.get(file) ?? []), key]);
    return key;
  };
  for (const pair of pairs) {
    const members = [pair.left, pair.right, ...(pair.instances ?? [])].map(add);
    for (const member of members.slice(1)) parent.set(find(member), find(members[0]!));
  }

  const families = new Map<string, { members: AnalyzerLocation[]; scores: number[]; best: JudgedPair | undefined }>();
  for (const [key, location] of locations) {
    const root = find(key);
    let family = families.get(root);
    if (family === undefined) {
      family = { members: [], scores: [], best: undefined };
      families.set(root, family);
    }
    family.members.push(location);
  }
  for (const pair of pairs) {
    const family = families.get(find(add(pair.left)))!;
    family.scores.push(pair.judgment.score);
    if (family.best === undefined || pair.judgment.score > family.best.judgment.score) family.best = pair;
  }

  return [...families.values()]
    .map((family) => {
      const shape: Shape = family.best?.judgment.shape ?? "extract_shared";
      return {
        members: family.members.sort((x, y) => x.filePath.localeCompare(y.filePath) || x.startLine - y.startLine),
        pairs: family.scores.length,
        maxScore: Math.max(...family.scores),
        meanScore: family.scores.reduce((sum, score) => sum + score, 0) / family.scores.length,
        shape,
        unsure: family.best?.verdict.unsure ?? false,
        borderline: family.best?.verdict.borderline ?? false,
        unstable: family.best?.verdict.unstable ?? false,
      };
    })
    .sort((x, y) => y.maxScore - x.maxScore || y.members.length - x.members.length);
}
