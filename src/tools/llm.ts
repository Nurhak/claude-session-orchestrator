// Local LLM / agent layer (spec §6): OpenAI-compatible endpoints on the machines, plus local agents.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { findMachine, UserError, type Endpoint } from '../config.ts';
import { run } from '../transport/ssh.ts';
import { tool, type Ctx } from './common.ts';
import { probe } from './machines.ts';

const inflight = new Map<string, number>(); // endpoint id → running requests (OpenAI APIs have no "busy" flag)
const timeoutS = () => Number(process.env.LLM_TIMEOUT_S ?? 300);

const base = (e: Endpoint) => e.url.replace(/\/$/, '');
const headers = (e: Endpoint) => ({ 'content-type': 'application/json', ...(e.api_key && { authorization: `Bearer ${e.api_key}` }) });

export async function up(e: Endpoint) {
  try {
    return (await fetch(`${base(e)}/models`, { headers: headers(e), signal: AbortSignal.timeout(2000) })).ok;
  } catch { return false; }
}

// shortcut: ~3.5 chars per token; upgrade to the model's tokenizer if tasks get close to ctx limits.
const tokens = (s: string) => Math.ceil(s.length / 3.5);

/** Auto-routing (spec §6): routing order, skip down, too-small ctx, and requires_ac machines not on AC. Idle ones first. */
export async function route(ctx: Ctx, need: number): Promise<{ picked: Endpoint[]; skipped: string[] }> {
  const skipped: string[] = [];
  const ok = await Promise.all(ctx.cfg.routing.map(async (id) => {
    const e = ctx.cfg.endpoints.find((x) => x.id === id)!;
    if (need > e.ctx) return void skipped.push(`${id}: context too small`);
    if (e.requires_ac) {
      const p = await probe(findMachine(ctx.cfg, e.machine));
      if (!p.reachable) return void skipped.push(`${id}: ${e.machine} unreachable`);
      if (p.power && p.power.source !== 'ac') return void skipped.push(`${id}: ${e.machine} on battery`);
    }
    if (!(await up(e))) return void skipped.push(`${id}: endpoint down`);
    return e;
  }));
  const picked = ok.filter((e): e is Endpoint => !!e);
  picked.sort((a, b) => Number((inflight.get(a.id) ?? 0) > 0) - Number((inflight.get(b.id) ?? 0) > 0)); // stable: keeps order
  return { picked, skipped };
}

async function complete(e: Endpoint, model: string, messages: { role: string; content: string }[], max_tokens: number) {
  inflight.set(e.id, (inflight.get(e.id) ?? 0) + 1);
  try {
    const r = await fetch(`${base(e)}/chat/completions`, {
      method: 'POST', headers: headers(e), signal: AbortSignal.timeout(timeoutS() * 1000),
      body: JSON.stringify({ model, messages, max_tokens, temperature: 0.2 }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json() as { choices?: { message?: { content?: string } }[]; usage?: unknown };
    const text = j.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('response has no choices[0].message.content');
    return { text, usage: j.usage };
  } finally {
    inflight.set(e.id, inflight.get(e.id)! - 1);
  }
}

export function register(server: McpServer, ctx: Ctx) {
  tool(server, ctx, 'llm_list', 'Registered local LLM endpoints: machine, URL, model, context length, up, busy.', {},
    async () => {
      const eps = await Promise.all(ctx.cfg.endpoints.map(async (e) => ({
        id: e.id, machine: e.machine, url: e.url, model: e.model, ctx: e.ctx,
        up: await up(e), busy: (inflight.get(e.id) ?? 0) > 0,
      })));
      const live = eps.filter((e) => e.up);
      return {
        summary: eps.length ? `${live.length} of ${eps.length} endpoints up${live.length ? `: ${live.map((e) => e.id).join(', ')}` : ''}.` : 'No LLM endpoints configured.',
        endpoints: eps, routing: ctx.cfg.routing,
      };
    });

  tool(server, ctx, 'llm_run', 'Run a small task (summarize, clean a log, classify, draft a simple edit) on a local model. endpoint="auto" routes by llm.yaml. Keep heavy or critical work in Claude Code.',
    {
      task: z.string().min(1),
      endpoint: z.string().default('auto'),
      model: z.string().optional(),
      max_tokens: z.number().int().min(1).max(32_000).default(1024),
      system: z.string().optional(),
    },
    async ({ task, endpoint, model, max_tokens, system }) => {
      const need = tokens(task) + tokens(system ?? '') + max_tokens;
      let cands: Endpoint[], skipped: string[] = [];
      if (endpoint === 'auto') {
        ({ picked: cands, skipped } = await route(ctx, need));
        if (!cands.length) throw new UserError(`No local model available. ${skipped.join('; ')}.`);
      } else {
        const e = ctx.cfg.endpoints.find((x) => x.id === endpoint);
        if (!e) throw new UserError(`Unknown endpoint "${endpoint}". Known: ${ctx.cfg.endpoints.map((x) => x.id).join(', ') || 'none'}.`);
        cands = [e];
      }
      const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: task }];
      const errors: string[] = [];
      for (const e of cands) {
        const t = Date.now();
        try {
          const { text, usage } = await complete(e, model ?? e.model, messages, max_tokens);
          return {
            summary: `${e.id} answered in ${((Date.now() - t) / 1000).toFixed(1)}s.`,
            endpoint: e.id, model: model ?? e.model, text, usage, skipped,
          };
        } catch (err) {
          errors.push(`${e.id}: ${(err as Error).message}`);
        }
      }
      throw new UserError(`Every endpoint failed. ${errors.join('; ')}.`);
    });

  tool(server, ctx, 'agent_run', 'Hand a task to a local agent (llm.yaml agents). Returns a job id; follow up with agent_status.',
    { agent: z.string(), task: z.string().min(1) },
    async ({ agent, task }) => {
      const a = ctx.cfg.agents.find((x) => x.id === agent);
      if (!a) throw new UserError(`Unknown agent "${agent}". Known: ${ctx.cfg.agents.map((x) => x.id).join(', ') || 'none'}.`);
      const m = findMachine(ctx.cfg, a.machine);
      const id = randomBytes(4).toString('hex');
      ctx.db.addJob(id, a.id, task);
      void (async () => {
        try {
          if (a.url) {
            const r = await fetch(a.url, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ task, job_id: id }), signal: AbortSignal.timeout(a.timeout_s * 1000),
            });
            const body = await r.text();
            ctx.db.finishJob(id, r.ok ? 'done' : 'failed', r.ok ? body : `HTTP ${r.status}: ${body.slice(0, 2000)}`);
          } else {
            const r = await run(m, a.cmd!, a.timeout_s * 1000, task);
            if (r.code === 255) ctx.db.finishJob(id, 'failed', `${m.id} unreachable or timed out`);
            else ctx.db.finishJob(id, r.code === 0 ? 'done' : 'failed', r.code === 0 ? r.stdout : `exit ${r.code}: ${r.stderr.slice(0, 2000)}`);
          }
        } catch (e) {
          ctx.db.finishJob(id, 'failed', (e as Error).message);
        }
      })();
      return { summary: `Sent to ${a.id} on ${a.machine}, job ${id}.`, job_id: id };
    });

  tool(server, ctx, 'agent_status', 'Status and result of an agent job.',
    { job_id: z.string() },
    async ({ job_id }) => {
      const j = ctx.db.job(job_id);
      if (!j) throw new UserError(`No job ${job_id}.`);
      const secs = Math.round(((j.finished ?? Date.now()) - j.started) / 1000);
      return {
        summary: j.status === 'running' ? `Job ${j.id} on ${j.agent} still running, ${secs}s so far.` : `Job ${j.id} on ${j.agent} ${j.status} after ${secs}s.`,
        status: j.status, result: j.result?.slice(0, 20_000) ?? null,
      };
    });
}
