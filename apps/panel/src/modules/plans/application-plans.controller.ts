import { Controller, Get, Param } from '@nestjs/common';
import { ApplicationApi } from '../auth/decorators.js';
import { PlansService } from './plans.service.js';

/**
 * The catalogue, as a billing system reads it.
 *
 * Read-only, and only the active offers. A retired plan still exists — the
 * customers on it are still running — but a system asking "what can I sell"
 * must not be handed something the operator withdrew, and the alternative
 * (returning it with a flag the integration is trusted to honour) is a flag
 * somebody eventually forgets to read.
 */
@Controller('api/application/plans')
@ApplicationApi()
export class ApplicationPlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  list() {
    return this.plans.list({ includeInactive: false });
  }

  /**
   * Whether this offer can be delivered right now, and what is in the way.
   *
   * The point of asking before selling rather than after: "sold out" on a
   * purchase page costs a sentence, and a refund costs a support ticket, a
   * payment reversal and the customer's afternoon. The answer names every node
   * that was passed over and why — maintenance, no free port, not enough
   * memory, not enough disk — because those are three different afternoons for
   * whoever has to fix it.
   */
  @Get(':slug/availability')
  async availability(@Param('slug') slug: string) {
    const { plan, placement } = await this.plans.placementFor(slug);

    return {
      plan: { slug: plan.slug, name: plan.name, active: plan.active },
      /**
       * `available` and not the node's name: which machine a server lands on
       * is the panel's business, and an integration that started routing on it
       * would break the day the operator adds a node.
       */
      available: placement.chosen !== null && plan.active,
      /** Named only when nothing fits, since that is when somebody must act. */
      blockedBy: placement.chosen === null ? placement.rejected : [],
    };
  }
}
