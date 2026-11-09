import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const Machine = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  ssh_host: z.string().optional(),
  user: z.string().optional(),
  os: z.enum(['linux', 'macos']).default('linux'),
  // A bare `~` in YAML parses as null; treat it as the home folder it was meant to be.
  projects_root: z.string().nullable().default('~/projects').transform((v) => v ?? '~'),
  local: z.boolean().default(false),
  // Command that starts Claude Code; tests swap it for a fake.
  claude_cmd: z.string().default('claude'),
}).refine((m) => m.local || m.ssh_host, { message: 'ssh_host is required unless local: true' });

const Project = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  aliases: z.array(z.string()).default([]),
  machine: z.string(),
  path: z.string().optional(), // relative to projects_root, or absolute / ~
  shared: z.array(z.string()).default([]),
});

const Endpoint = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  machine: z.string(),
  url: z.string().url(), // OpenAI-compatible base, including /v1
  model: z.string(),
  ctx: z.number().default(8192),
  max_vram_gb: z.number().optional(),
  requires_ac: z.boolean().default(false), // auto routing skips it when the machine is on battery
  api_key: z.string().optional(),
});

const Agent = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  machine: z.string(),
  url: z.string().url().optional(), // POST {"task": "..."}; the response body is the result
  cmd: z.string().optional(),       // or: shell command on the machine, task on stdin, stdout is the result
  timeout_s: z.number().default(1800),
}).refine((a) => !!a.url !== !!a.cmd, { message: 'agent needs exactly one of url or cmd' });

const Llm = z.object({
  endpoints: z.array(Endpoint).default([]),
  routing: z.object({ order: z.array(z.string()).optional() }).default({}),
  agents: z.array(Agent).default([]),
});

export type Machine = z.infer<typeof Machine>;
export type Project = z.infer<typeof Project>;
export type Endpoint = z.infer<typeof Endpoint>;
export type Agent = z.infer<typeof Agent>;

export interface Config {
  machines: Machine[];
  projects: Project[];
  endpoints: Endpoint[];
  routing: string[]; // endpoint ids tried in order by llm_run endpoint="auto"
  agents: Agent[];
}

function load(dir: string, file: string, required: boolean): Record<string, unknown> {
  const p = join(dir, file);
  if (!existsSync(p)) {
    if (required) throw new Error(`missing config file ${p}`);
    return {};
  }
  return parse(readFileSync(p, 'utf8')) ?? {};
}

export function loadConfig(dir = process.env.CONFIG_DIR ?? 'config'): Config {
  const machines = z.array(Machine).parse(load(dir, 'machines.yaml', true).machines ?? []);
  const projects = z.array(Project).parse(load(dir, 'projects.yaml', true).projects ?? []);
  const llm = Llm.parse(load(dir, 'llm.yaml', false));
  const ids = new Set(machines.map((m) => m.id));
  const check = (what: string, machine: string) => {
    if (!ids.has(machine)) throw new Error(`${what}: unknown machine ${machine}`);
  };
  for (const p of projects) check(`project ${p.id}`, p.machine);
  for (const e of llm.endpoints) check(`endpoint ${e.id}`, e.machine);
  for (const a of llm.agents) check(`agent ${a.id}`, a.machine);
  const routing = llm.routing.order ?? llm.endpoints.map((e) => e.id);
  for (const id of routing) {
    if (!llm.endpoints.some((e) => e.id === id)) throw new Error(`routing.order: unknown endpoint ${id}`);
  }
  return { machines, projects, endpoints: llm.endpoints, routing, agents: llm.agents };
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
