import { describe, expect, it } from 'vitest';
import { cacheControlFor, isApiPath, resolveWebRoot } from './web-assets.js';

/**
 * Ces tests existent parce que le panel déployé répondait 404 sur `/` : l'API
 * tournait, mais aucune interface n'était servie. Vite s'en chargeait en
 * développement, et personne ne prenait le relais en production.
 */
describe('isApiPath', () => {
  // Le repli SPA renvoie `index.html` pour toute URL inconnue. Appliqué à
  // l'API, il ferait recevoir du HTML à un client qui attend du JSON — panne
  // bien plus difficile à diagnostiquer qu'une 404 franche.
  it.each(['/api', '/api/', '/api/servers', '/api/auth/login'])('reconnaît %s', (path) => {
    expect(isApiPath(path)).toBe(true);
  });

  it.each(['/', '/servers/abc', '/assets/index-a1b2.js', '/apiary', '/x/api/y'])(
    'laisse %s à l’interface',
    (path) => {
      expect(isApiPath(path)).toBe(false);
    },
  );
});

describe('cacheControlFor', () => {
  // Vite appose une empreinte au nom des fichiers d'`assets/` : sous un même
  // nom, le contenu ne change jamais.
  it('rend les fichiers empreintés immuables', () => {
    expect(cacheControlFor('/assets/index-a1b2c3.js')).toContain('immutable');
    expect(cacheControlFor('/assets/index-a1b2c3.js')).toContain('max-age=31536000');
  });

  // `index.html` référence ces noms empreintés. S'il était mis en cache, un
  // navigateur continuerait de charger l'ancienne application après une mise à
  // jour, en réclamant des fichiers qui n'existent plus.
  it('interdit la mise en cache du document', () => {
    expect(cacheControlFor('/index.html')).toContain('no-cache');
    expect(cacheControlFor('/')).toContain('no-cache');
  });
});

describe('resolveWebRoot', () => {
  // Le défaut est relatif au répertoire de travail, qui est `apps/panel` dans
  // l'unité systemd.
  it('résout le défaut depuis le répertoire de travail', () => {
    // Suffixe et non égalité : sous Windows, `resolve` préfixe la lettre de
    // lecteur. Ce qui est vérifié, c'est que le chemin est bien ancré au
    // répertoire de travail.
    const resolved = resolveWebRoot('web/dist', '/opt/hopper/apps/panel').replace(/\\/g, '/');
    expect(resolved).toMatch(/\/opt\/hopper\/apps\/panel\/web\/dist$/);
  });

  // Un déploiement qui range le front ailleurs doit pouvoir l'imposer sans que
  // le panel réinterprète le chemin.
  it('respecte un chemin absolu', () => {
    const resolved = resolveWebRoot('/srv/hopper-ui', '/opt/hopper/apps/panel').replace(/\\/g, '/');
    expect(resolved).toMatch(/\/srv\/hopper-ui$/);
  });
});
