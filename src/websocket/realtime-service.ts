import type { Server as SocketIOServer } from 'socket.io';
import { logger } from '../lib/logger.js';
import type { SimulationEvent, SimulationEventSink } from '../simulation/simulation-events.js';
import type { ClientToServerEvents, RealtimeEvent, ServerToClientEvents } from './events.js';
import { roomsFor } from './rooms.js';

/**
 * Domain event -> rooms -> Socket.IO (CLAUDE.md §14).
 *
 * This is the only place in the codebase that turns a domain event into a wire
 * message. Domain services (the simulation engine today; the dock and alert
 * engines in later phases) hand it a `RealtimeEvent` and never see a socket.
 */

export type RealtimeServer = SocketIOServer<ClientToServerEvents, ServerToClientEvents>;

/**
 * The narrow slice of Socket.IO the service actually uses, so the routing tests
 * can record emissions without standing up a server.
 */
export interface RealtimeEmitter {
  to(rooms: string[]): { emit(event: string, payload: unknown): void };
}

/**
 * Adapts a Socket.IO server to `RealtimeEmitter`. `BroadcastOperator.emit` is
 * generic over the event map and cannot correlate a *union* of event names with
 * a union of payloads, so the pairing is enforced by `RealtimeEvent` (which
 * ties each name to its payload) and erased with one cast here rather than a
 * seven-arm switch that would duplicate `roomsFor`.
 */
export function socketEmitter(io: RealtimeServer): RealtimeEmitter {
  return {
    to(rooms) {
      const target = io.to(rooms);
      return {
        emit(event, payload) {
          (target.emit as unknown as (name: string, data: unknown) => void)(event, payload);
        },
      };
    },
  };
}

export class RealtimeService {
  constructor(private readonly emitter: RealtimeEmitter) {}

  emit(event: RealtimeEvent): void {
    const rooms = roomsFor(event);
    this.emitter.to(rooms).emit(event.type, event.data);
    // Debug, never info: there are ~9 position events every 2 seconds.
    logger.debug(`-> ${event.type} to ${rooms.join(', ')}`);
  }

  /**
   * The sink the simulation manager is given. `SimulationEvent` is a subset of
   * `RealtimeEvent`, so this is a straight pass-through — and it is what lets
   * the engine stay free of any Socket.IO import.
   */
  asSimulationEventSink(): SimulationEventSink {
    return {
      emit: (event: SimulationEvent) => {
        this.emit(event);
      },
    };
  }
}
