import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const Machine = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  ssh_host: z.string().optional(),
  user: z.string().optional(),
  os: z.enum(['linux', 'macos']).default('linux'),
  projects_root: z.string().default('~/projects'),
  local: z.boolean().default(false),
  // Command that starts Claude Code; tests swap it for a fake.
  claude_cmd: z.string().default('claude --remote-control'),
}).refine((m) => m.local || m.ssh_host, { message: 'ssh_host is required unless local: true' });

const Project = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  aliases: z.array(z.string()).default([]),
  machine: z.string(),
  path: z.string().optional(), // relative to projects_root, or absolute / ~
  shared: z.array(z.string()).default([]),
});

const Endpoint = z.object({
  machine: z.string(),
  url: z.string().url(),
  model: z.string(),
  ctx: z.number().optional(),
  max_vram_gb: z.number().optional(),
});

export type Machine = z.infer<typeof Machine>;
export type Project = z.infer<typeof Project>;
export type Endpoint = z.infer<typeof Endpoint>;

export interface Config {
  machines: Machine[];
  projects: Project[];
  endpoints: Endpoint[];
}

function load(dir: string, file: string, key: string, required: boolean): unknown[] {
  const p = join(dir, file);
  if (!existsSync(p)) {
    if (required) throw new Error(`missing config file ${p}`);
    return [];
  }
  return (parse(readFileSync(p, 'utf8')) ?? {})[key] ?? [];
}

export function loadConfig(dir = process.env.CONFIG_DIR ?? 'config'): Config {
  const machines = z.array(Machine).parse(load(dir, 'machines.yaml', 'machines', true));
  const projects = z.array(Project).parse(load(dir, 'projects.yaml', 'projects', true));
  const endpoints = z.array(Endpoint).parse(load(dir, 'llm.yaml', 'endpoints', false));
  const ids = new Set(machines.map((m) => m.id));
  for (const p of projects) {
    if (!ids.has(p.machine)) throw new Error(`project ${p.id}: unknown machine ${p.machine}`);
  }
  return { machines, projects, endpoints };
}

export function findMachine(cfg: Config, id: string): Machine {
  const m = cfg.machines.find((x) => x.id === id.toLowerCase());
  if (!m) throw new UserError(`Unknown machine "${id}". Known: ${cfg.machines.map((x) => x.id).join(', ')}.`);
  return m;
}

export function findProject(cfg: Config, name: string): Project {
  const n = name.toLowerCase();
  const p = cfg.projects.find((x) => x.id === n || x.aliases.some((a) => a.toLowerCase() === n));
  if (!p) throw new UserError(`Unknown project "${name}". Known: ${cfg.projects.map((x) => x.id).join(', ')}.`);
  return p;
}

export function projectDir(m: Machine, p: Project): string {
  const path = p.path ?? p.id;
  return path.startsWith('/') || path.startsWith('~') ? path : `${m.projects_root}/${path}`;
}

/** Errors whose message is meant to be read out to the user as-is. */
export class UserError extends Error {}
