import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { findMachine, type Machine } from '../config.ts';
import { run, runOk } from '../transport/ssh.ts';
import { tool, type Ctx } from './common.ts';

const PROBE = `tmux list-sessions -F '#S' 2>/dev/null | grep -c '^cc-'; pmset -g batt 2>/dev/null | head -2 | tr '\\n' ' '; true`;

export async function probe(m: Machine) {
  const r = await run(m, PROBE);
  if (r.code === 255) return { id: m.id, reachable: false, sessions: 0 };
  const [count, batt] = r.stdout.split('\n');
  const power = m.os === 'macos' && batt
    ? { source: /'AC Power'/.test(batt) ? 'ac' : 'battery',
        percent: Number(batt.match(/(\d+)%/)?.[1] ?? NaN) }
    : undefined;
  return { id: m.id, reachable: true, sessions: Number(count) || 0, ...(power && { power }) };
}

const LINUX = `
echo "cpus=$(nproc)"; echo "load=$(cut -d' ' -f1 /proc/loadavg)"
free -m | awk '/^Mem:/{print "ram_used_mb="$3; print "ram_total_mb="$2}'
df -h "$HOME" | awk 'NR==2{print "disk_used="$3; print "disk_total="$2; print "disk_pct="$5}'
command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits | sed 's/^/gpu=/'
dev=$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* dev \\([^ ]*\\).*/\\1/p')
[ -n "$dev" ] && { [ -d "/sys/class/net/$dev/wireless" ] && echo link=wifi || echo link=ethernet; }
true`;

const MACOS = `
echo "cpus=$(sysctl -n hw.ncpu)"; echo "load=$(sysctl -n vm.loadavg | awk '{print $2}')"
echo "ram_total_mb=$(( $(sysctl -n hw.memsize) / 1048576 ))"
echo "ram_free_pct=$(memory_pressure 2>/dev/null | awk -F': ' '/free percentage/{print $2}')"
df -h "$HOME" | awk 'NR==2{print "disk_used="$3; print "disk_total="$2; print "disk_pct="$5}'
dev=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
networksetup -listallhardwareports | grep -B1 "Device: $dev" | grep -q Wi-Fi && echo link=wifi || echo link=ethernet
true`;

export function parseKv(out: string) {
  const o: Record<string, unknown> = {};
  const gpus: unknown[] = [];
  for (const line of out.split('\n')) {
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i), v = line.slice(i + 1).trim();
    if (k === 'gpu') {
      const [name, util, used, total] = v.split(',').map((s) => s.trim());
      gpus.push({ name, util_pct: +util, vram_used_mb: +used, vram_total_mb: +total });
    } else o[k] = /^\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  if (gpus.length) o.gpus = gpus;
  return o;
}

async function endpointUp(url: string) {
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

export function register(server: McpServer, ctx: Ctx) {
  tool(server, ctx, 'machine_list', 'List machines: reachable or not, open Claude Code session count, and MacBook power (AC/battery).', {},
    async () => {
      const ms = await Promise.all(ctx.cfg.machines.map(probe));
      const down = ms.filter((m) => !m.reachable).map((m) => m.id);
      const total = ms.reduce((n, m) => n + m.sessions, 0);
      return {
        summary: `${ms.length - down.length} of ${ms.length} machines reachable, ${total} sessions open.${down.length ? ` Unreachable: ${down.join(', ')}.` : ''}`,
        machines: ms,
      };
    });

  tool(server, ctx, 'machine_status', 'CPU, RAM, disk, GPU/VRAM, network link (ethernet/wifi) and local LLM endpoints of one machine.',
    { machine: z.string().describe('Machine id, e.g. macbook, node2, gpu') },
    async ({ machine }) => {
      const m = findMachine(ctx.cfg, machine);
      const s = parseKv(await runOk(m, m.os === 'macos' ? MACOS : LINUX, 8000));
      const eps = ctx.cfg.endpoints.filter((e) => e.machine === m.id);
      const llm = await Promise.all(eps.map(async (e) => ({ model: e.model, url: e.url, up: await endpointUp(e.url) })));
      const gpu = (s.gpus as { util_pct: number; vram_used_mb: number; vram_total_mb: number }[] | undefined)?.[0];
      return {
        summary: `${m.id}: load ${s.load} on ${s.cpus} CPUs, disk ${s.disk_pct} full` +
          (gpu ? `, GPU ${gpu.util_pct}% with ${Math.round(gpu.vram_used_mb / 1024)} of ${Math.round(gpu.vram_total_mb / 1024)} GB VRAM used` : '') +
          `, on ${s.link ?? 'unknown link'}.`,
        ...s,
        llm_endpoints: llm,
      };
    });
}
