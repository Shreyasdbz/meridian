// @meridian/axis — Component registry
// Manages component registration and handler lookup for in-process message dispatch.

import type {
  ComponentId,
  ComponentRegistry,
  MessageHandler,
} from '@meridian/shared';
import { ConflictError, NotFoundError, ValidationError } from '@meridian/shared';

/**
 * Regex for validating ComponentId format.
 * Matches: 'bridge', 'scout', 'sentinel', 'journal', or 'gear:<name>'
 * where <name> is a non-empty string of lowercase alphanumeric, hyphens, and underscores.
 */
const COMPONENT_ID_REGEX = /^(bridge|scout|sentinel|journal|gear:[a-z0-9_-]+)$/;

/**
 * ComponentRegistryImpl — manages registration and lookup of component message handlers.
 *
 * Implements the ComponentRegistry interface from shared/ for use by registering
 * components, and adds additional lookup methods for the Axis router.
 *
 * Each core component registers a handler during startup. The router uses
 * this registry to find the appropriate handler when dispatching messages.
 */
export class ComponentRegistryImpl implements ComponentRegistry {
  private readonly handlers = new Map<string, MessageHandler>();

  /**
   * Register a message handler for a component.
   *
   * @throws ValidationError if the ComponentId format is invalid
   * @throws ConflictError if the component is already registered
   */
  register(componentId: ComponentId, handler: MessageHandler): void {
    if (!COMPONENT_ID_REGEX.test(componentId)) {
      throw new ValidationError(
        `Invalid ComponentId format: '${componentId}'`,
      );
    }

    if (this.handlers.has(componentId)) {
      throw new ConflictError(
        `Component '${componentId}' is already registered`,
      );
    }

    this.handlers.set(componentId, handler);
  }

  /**
   * Unregister a component's message handler.
   *
   * @throws NotFoundError if the component is not registered
   */
  unregister(componentId: ComponentId): void {
    if (!this.handlers.has(componentId)) {
      throw new NotFoundError(
        `Component '${componentId}' is not registered`,
      );
    }

    this.handlers.delete(componentId);
  }

  /**
   * Look up the handler for a component.
   * Returns undefined if no handler is registered for the given component.
   */
  getHandler(componentId: ComponentId): MessageHandler | undefined {
    return this.handlers.get(componentId);
  }

  /**
   * Check whether a component is registered.
   */
  has(componentId: ComponentId): boolean {
    return this.handlers.has(componentId);
  }

  /**
   * Get the list of all registered component IDs.
   */
  getRegisteredComponents(): ComponentId[] {
    return [...this.handlers.keys()] as ComponentId[];
  }

  /**
   * Remove all registered components. Used for testing and shutdown.
   */
  clear(): void {
    this.handlers.clear();
  }
}
