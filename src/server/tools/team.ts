/**
 * Team Tools
 *
 * Parent-session orchestration: one persistent OpenCode session acts as
 * team lead, spawning native `task` subagents (visible in the TUI
 * overview) that share its conversation context.
 */

import { z } from 'zod';
import type { OpenCodeClient } from '../../client/opencode.js';
import { resolveModel } from '../../client/opencode.js';
import { getWorkingDirectory } from './execution.js';
import { createErrorResponse, ERROR_SUGGESTIONS } from './schemas.js';

// ============================================================================
// Input Schemas (exported for MCP SDK)
// ============================================================================

export const INPUT_SCHEMAS = {
  TeamInputSchema: {
    goal: z.string().min(1, { error: 'Goal is required' }).describe('Overall goal for the team'),
    subtasks: z.array(z.string().min(1)).min(1, { error: 'At least one subtask is required' }).describe('Parallel work items for task subagents'),
    sessionId: z.string().optional().describe('Existing parent session ID (creates one if omitted)'),
    parentAgent: z.string().optional().describe('Lead agent; must allow the task tool (default: build)'),
    model: z.string().optional().describe('Model in format provider/model'),
    workingDirectory: z.string().optional().describe('Project directory path (auto-detected if not specified)'),
    title: z.string().optional().describe('Title for a new parent session'),
  },

  SessionIdInputSchema: {
    sessionId: z.string().min(1, { error: 'Session ID is required' }).describe('Parent session ID'),
  },
};

// ============================================================================
// Tool Definitions (for documentation/tests)
// ============================================================================

export function getTeamToolDefinitions(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return [
    {
      name: 'opencode_team',
      description: 'Run parallel work through a parent OpenCode session that spawns native task subagents. The parent shares its conversation context with children (visible in the TUI task overview) and returns a consolidated summary.',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'Overall goal for the team' },
          subtasks: { type: 'array', items: { type: 'string' }, description: 'Parallel work items for task subagents' },
          sessionId: { type: 'string', description: 'Existing parent session ID (creates one if omitted)' },
          parentAgent: { type: 'string', description: 'Lead agent; must allow the task tool (default: build)' },
          model: { type: 'string', description: 'Model in format provider/model' },
          workingDirectory: { type: 'string', description: 'Project directory path' },
          title: { type: 'string', description: 'Title for a new parent session' },
        },
        required: ['goal', 'subtasks'],
      },
    },
    {
      name: 'opencode_session_children',
      description: 'List child task sessions spawned by a parent session (the same subagents shown in the TUI task overview).',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Parent session ID' },
        },
        required: ['sessionId'],
      },
    },
  ];
}

// ============================================================================
// Handlers
// ============================================================================

export function createTeamHandlers(client: OpenCodeClient, defaultModel?: string) {
  return {
    async opencode_team(params: {
      goal: string;
      subtasks: string[];
      sessionId?: string;
      parentAgent?: string;
      model?: string;
      workingDirectory?: string;
      title?: string;
    }) {
      try {
        let workingDir: { directory: string; source: string };
        try {
          workingDir = await getWorkingDirectory(params.workingDirectory);
        } catch (e) {
          return createErrorResponse(
            'Detecting working directory',
            e,
            [
              'Specify workingDirectory parameter explicitly',
              'Make sure you are in a project directory with .git or package.json',
            ]
          );
        }

        // Reuse or create the parent (team lead) session
        let sessionId = params.sessionId;
        let created = false;
        if (!sessionId) {
          const session = await client.createSession(
            params.title ?? `team: ${params.goal.slice(0, 60)}`,
            resolveModel(params.model, defaultModel),
            workingDir.directory
          );
          sessionId = session.id;
          created = true;
        }

        const leadAgent = params.parentAgent ?? 'build';
        const items = params.subtasks
          .map((s, i) => `${i + 1}. ${s}`)
          .join('\n');
        const leadPrompt =
          `You are the team lead. GOAL: ${params.goal}\n\n` +
          `Spawn one task subagent per item below (run them in parallel via the task tool). ` +
          `Give each subagent all context it needs from this conversation so it can work independently:\n${items}\n\n` +
          `Rules: wait for all subagents; if one fails, retry once with narrower scope, then report it as failed. ` +
          `When all are done, reply with a consolidated summary: per-item status (done/failed), key results, files changed.`;

        const result = await client.prompt(sessionId, leadPrompt, {
          model: resolveModel(params.model, defaultModel),
          agent: leadAgent,
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            sessionId: result.sessionId,
            parentCreated: created,
            parentAgent: leadAgent,
            messageId: result.messageId,
            subtasks: params.subtasks.length,
            summary: result.content,
            workingDirectory: workingDir.directory,
          }, null, 2) }],
        };
      } catch (error) {
        return createErrorResponse(
          'Running team task',
          error,
          ERROR_SUGGESTIONS.connectionFailed
        );
      }
    },

    async opencode_session_children(params: { sessionId: string }) {
      try {
        const children = await client.listChildren(params.sessionId);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            sessionId: params.sessionId,
            count: children.length,
            children,
          }, null, 2) }],
        };
      } catch (error) {
        return createErrorResponse(
          'Listing child sessions',
          error,
          ERROR_SUGGESTIONS.connectionFailed
        );
      }
    },
  };
}

export type TeamHandlers = ReturnType<typeof createTeamHandlers>;
