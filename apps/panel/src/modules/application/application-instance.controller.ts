import { Controller, Get } from '@nestjs/common';
import { PANEL_VERSION } from '../../version.js';
import { ApplicationApi } from '../auth/decorators.js';
import { decodePermissions } from './application-permissions.js';
import { CurrentApplication, type RequestApplication } from '../auth/request-user.js';

/**
 * The first call an integrator makes, and the one they come back to.
 *
 * It answers three questions that are otherwise each a support ticket: is this
 * key reaching the right panel, what is it allowed to do, and what does this
 * version of the panel understand. Without it, the cheapest way to test a
 * credential is to provision a server — which either works or leaves a customer
 * with something to delete.
 *
 * Reachable with a `read` key, deliberately: checking a credential must not
 * require the credential that can change things.
 */
@Controller('api/application')
@ApplicationApi()
export class ApplicationInstanceController {
  @Get('instance')
  instance(@CurrentApplication() application: RequestApplication) {
    return {
      panel: {
        /**
         * The version is here so an integration can refuse to run against a
         * panel older than the routes it depends on, rather than discover the
         * gap as a 404 in the middle of provisioning.
         */
        version: PANEL_VERSION,
        api: APPLICATION_API_VERSION,
      },
      /**
       * Echoed back so an operator holding several keys can tell which one a
       * configuration file actually contains — without the token, which they
       * cannot read anywhere by design.
       */
      key: {
        uuid: application.uuid,
        name: application.name,
        /**
         * Decoded rather than raw. An integrator checking "may I provision"
         * should read `{"servers": "write"}` and not have to split
         * `servers:write` themselves — and the stored form is ours to change.
         */
        permissions: decodePermissions(application.permissions),
      },
    };
  }
}

/**
 * Version of the application API's contract, moved by hand.
 *
 * Distinct from the panel's version, which moves on every release including
 * the ones that change nothing here. An integration pins against this one, so
 * it only has to react when the contract it depends on actually moves.
 *
 * The rule for moving it: a new route or a new optional field does not; a
 * removed field, a renamed one, or a changed meaning does.
 */
export const APPLICATION_API_VERSION = 1;
