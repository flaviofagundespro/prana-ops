/**
 * Drift-guard for the ws contract mirror (AC9, Story 1.4).
 *
 * `web/src/ws-protocol.ts` is a TYPE-ONLY mirror of `server/src/ws/protocol.ts`
 * (the canonical source). There is no shared package yet, so the two must be kept
 * in sync by hand. This test is the "cheap insurance" the Story 1.2 gate asked for
 * before 1.4 grew the contract: it FAILS AT COMPILE TIME (typecheck) if either
 * side renames, removes, or changes the type of a mirrored field.
 *
 * MECHANISM (ratified @po point 2): compile-time STRUCTURAL EQUALITY via mutual
 * assignability. Both modules are pure `type`/`interface` files with NO runtime
 * dependency, so importing both here drags no Node-vs-DOM runtime in — only type
 * shapes. `AssertMutual<A, B>` resolves to `true` only if A extends B AND B
 * extends A (structurally identical); any drift makes the type `false`, and the
 * `const _check: true = ...` assignment fails `tsc --noEmit`. The runtime `expect`
 * exists only so vitest counts this as a passing test when types are in sync.
 *
 * Covered messages (the subset the frontend consumes):
 *   channel:*  ChannelOpenRequest, ChannelDataClientMessage, ChannelResizeMessage,
 *              ChannelCloseMessage, ChannelOpenAck, ChannelDataServerMessage,
 *              ChannelCloseServerMessage, ChannelStateMessage, ChannelErrorMessage,
 *              ConnectionState
 *   session:*  SessionCreateRequest, SessionListRequest, SessionCreatedAck,
 *              SessionListResult, SessionErrorMessage
 *   history:*  HistoryRequest, HistoryResult, HistoryErrorMessage (Story 1.5)
 */
import { describe, it, expect } from 'vitest';

import type * as Server from '../../src/ws/protocol.js';
// Type-only import of the frontend mirror. No runtime code crosses the boundary.
import type * as Web from '../../../web/src/ws-protocol.js';

/** true iff A is assignable to B. */
type Extends<A, B> = A extends B ? true : false;
/** true iff A and B are mutually assignable (structurally identical). */
type AssertMutual<A, B> = Extends<A, B> extends true
  ? Extends<B, A> extends true
    ? true
    : false
  : false;

// Each line below fails `tsc --noEmit` if the two shapes drift apart.
const channelOpenRequest: AssertMutual<Server.ChannelOpenRequest, Web.ChannelOpenRequest> = true;
const channelDataClient: AssertMutual<Server.ChannelDataClientMessage, Web.ChannelDataClientMessage> = true;
const channelResize: AssertMutual<Server.ChannelResizeMessage, Web.ChannelResizeMessage> = true;
const channelClose: AssertMutual<Server.ChannelCloseMessage, Web.ChannelCloseMessage> = true;
const channelOpenAck: AssertMutual<Server.ChannelOpenAck, Web.ChannelOpenAck> = true;
const channelDataServer: AssertMutual<Server.ChannelDataServerMessage, Web.ChannelDataServerMessage> = true;
const channelCloseServer: AssertMutual<Server.ChannelCloseServerMessage, Web.ChannelCloseServerMessage> = true;
const channelState: AssertMutual<Server.ChannelStateMessage, Web.ChannelStateMessage> = true;
const channelError: AssertMutual<Server.ChannelErrorMessage, Web.ChannelErrorMessage> = true;
const connectionState: AssertMutual<Server.ConnectionState, Web.ConnectionState> = true;

const sessionCreate: AssertMutual<Server.SessionCreateRequest, Web.SessionCreateRequest> = true;
const sessionList: AssertMutual<Server.SessionListRequest, Web.SessionListRequest> = true;
const sessionCreatedAck: AssertMutual<Server.SessionCreatedAck, Web.SessionCreatedAck> = true;
const sessionListResult: AssertMutual<Server.SessionListResult, Web.SessionListResult> = true;
const sessionError: AssertMutual<Server.SessionErrorMessage, Web.SessionErrorMessage> = true;

// history:* (Story 1.5) — same AssertMutual technique, no new mechanism.
const historyRequest: AssertMutual<Server.HistoryRequest, Web.HistoryRequest> = true;
const historyResult: AssertMutual<Server.HistoryResult, Web.HistoryResult> = true;
const historyError: AssertMutual<Server.HistoryErrorMessage, Web.HistoryErrorMessage> = true;

// profile:test-connection* (Story 1.6) — same AssertMutual technique, additive.
const profileTestReq: AssertMutual<
  Server.ProfileTestConnectionRequest,
  Web.ProfileTestConnectionRequest
> = true;
const profileTestRes: AssertMutual<
  Server.ProfileTestConnectionResult,
  Web.ProfileTestConnectionResult
> = true;

// decisions:* / sessions:state (Story 2.6) — same AssertMutual technique, additive.
const decisionsAction: AssertMutual<Server.DecisionsActionRequest, Web.DecisionsActionRequest> = true;
const decisionQueueItem: AssertMutual<Server.DecisionQueueItem, Web.DecisionQueueItem> = true;
const sessionStateItem: AssertMutual<Server.SessionStateItem, Web.SessionStateItem> = true;
const watcherStateName: AssertMutual<Server.WatcherSessionStateName, Web.WatcherSessionStateName> = true;
const decisionsUpdate: AssertMutual<Server.DecisionsUpdateMessage, Web.DecisionsUpdateMessage> = true;
const sessionsState: AssertMutual<Server.SessionsStateMessage, Web.SessionsStateMessage> = true;
const decisionsError: AssertMutual<Server.DecisionsErrorMessage, Web.DecisionsErrorMessage> = true;

// decisions:respond* (Story 2.7) — same AssertMutual technique, additive.
const decisionsRespond: AssertMutual<Server.DecisionsRespondRequest, Web.DecisionsRespondRequest> = true;
const respondChallenge: AssertMutual<Server.DecisionsRespondChallenge, Web.DecisionsRespondChallenge> = true;
const respondResult: AssertMutual<Server.DecisionsRespondResult, Web.DecisionsRespondResult> = true;

describe('ws protocol drift-guard (AC9)', () => {
  it('keeps channel:* mirror types structurally identical (compile-time)', () => {
    expect(
      channelOpenRequest &&
        channelDataClient &&
        channelResize &&
        channelClose &&
        channelOpenAck &&
        channelDataServer &&
        channelCloseServer &&
        channelState &&
        channelError &&
        connectionState,
    ).toBe(true);
  });

  it('keeps session:* mirror types structurally identical (compile-time)', () => {
    expect(sessionCreate && sessionList && sessionCreatedAck && sessionListResult && sessionError).toBe(true);
  });

  it('keeps history:* mirror types structurally identical (compile-time) (Story 1.5)', () => {
    expect(historyRequest && historyResult && historyError).toBe(true);
  });

  it('keeps profile:test-connection* mirror types structurally identical (compile-time) (Story 1.6)', () => {
    expect(profileTestReq && profileTestRes).toBe(true);
  });

  it('keeps decisions:*/sessions:state mirror types structurally identical (compile-time) (Story 2.6)', () => {
    expect(
      decisionsAction &&
        decisionQueueItem &&
        sessionStateItem &&
        watcherStateName &&
        decisionsUpdate &&
        sessionsState &&
        decisionsError,
    ).toBe(true);
  });

  it('keeps decisions:respond* mirror types structurally identical (compile-time) (Story 2.7)', () => {
    expect(decisionsRespond && respondChallenge && respondResult).toBe(true);
  });
});
