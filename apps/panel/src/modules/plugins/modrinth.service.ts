import { BadGatewayException, Injectable, Logger, NotFoundException } from '@nestjs/common';

/**
 * The catalogue, frozen in code.
 *
 * Deliberately not a setting, for the same reason the update check's repository
 * is not: an administrator who could point this elsewhere would turn a search
 * box into a request the panel makes on their behalf from inside the network.
 * The daemon refuses to download from anywhere but the matching CDN, so a
 * second catalogue would need that list changed too — which is where the
 * decision belongs.
 */
const API = 'https://api.modrinth.com/v2';

/** Modrinth asks projects to identify themselves, and rate-limits those that do not. */
const USER_AGENT = 'hopper-panel/0.0.0-dev (github.com/hopper-panel/hopper)';

const TIMEOUT_MS = 10_000;

export interface PluginSearchHit {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  downloads: number;
  iconUrl: string | null;
  categories: string[];
}

/**
 * A page of results, in the shape the rest of the panel already paginates in.
 *
 * The catalogue holds tens of thousands of projects. Returning the first
 * twenty and nothing else said neither how many there were nor how to reach
 * the twenty-first — the page looked like the whole catalogue.
 */
export interface PluginSearchPage {
  data: PluginSearchHit[];
  meta: { currentPage: number; perPage: number; lastPage: number; total: number };
}

/** Modrinth's own ceiling. Asking for more is refused, not truncated. */
export const MAX_PER_PAGE = 100;

export interface PluginVersion {
  versionId: string;
  name: string;
  versionNumber: string;
  gameVersions: string[];
  loaders: string[];
  datePublished: string;
  /** The primary file: what actually gets installed. */
  file: { filename: string; url: string; sizeBytes: number; sha512: string | null };
}

/**
 * Modrinth, read-only.
 *
 * The panel never downloads anything here. It resolves a version into a file
 * URL and hands that to the daemon, which holds the volume and enforces its own
 * allowlist. Two reasons: a plugin would otherwise cross the panel in full,
 * which a modpack of several hundred megabytes makes expensive for every user
 * of that panel at once; and the panel has no business holding a server's files
 * even briefly.
 */
@Injectable()
export class ModrinthService {
  private readonly logger = new Logger(ModrinthService.name);

  async search(
    query: string,
    loader?: string,
    gameVersion?: string,
    page = 1,
    perPage = 30,
  ): Promise<PluginSearchPage> {
    // `facets` is Modrinth's filter syntax: an array of OR-groups, ANDed
    // together. Passing the loader and the game version narrows the list to
    // what will actually run on this server, which is the difference between a
    // search box and a useful one.
    const facets: string[][] = [['project_type:mod', 'project_type:plugin']];

    if (loader) {
      facets.push([`categories:${loader}`]);
    }

    if (gameVersion) {
      facets.push([`versions:${gameVersion}`]);
    }

    const limit = Math.min(Math.max(perPage, 1), MAX_PER_PAGE);
    const current = Math.max(page, 1);

    const url = new URL(`${API}/search`);
    url.searchParams.set('query', query);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String((current - 1) * limit));
    url.searchParams.set('facets', JSON.stringify(facets));

    // Relevance is meaningless without a query: Modrinth would rank an empty
    // string against every project and return an arbitrary slice. Sorting by
    // downloads is what makes the page useful before anyone has typed —
    // "what does everyone else run on this loader" is the question a new
    // operator actually has.
    url.searchParams.set('index', query.trim() === '' ? 'downloads' : 'relevance');

    const body = await this.get<{
      total_hits: number;
      hits: {
        project_id: string;
        slug: string;
        title: string;
        description: string;
        downloads: number;
        icon_url: string | null;
        categories: string[];
      }[];
    }>(url);

    const data = body.hits.map((hit) => ({
      projectId: hit.project_id,
      slug: hit.slug,
      title: hit.title,
      description: hit.description,
      downloads: hit.downloads,
      iconUrl: hit.icon_url,
      categories: hit.categories,
    }));

    const total = body.total_hits;

    return {
      data,
      meta: {
        currentPage: current,
        perPage: limit,
        // A last page of zero would leave the bar with no page to point at,
        // and "page 1 of 0" reads as a bug rather than as an empty search.
        lastPage: Math.max(1, Math.ceil(total / limit)),
        total,
      },
    };
  }

  async versions(
    projectId: string,
    loader?: string,
    gameVersion?: string,
  ): Promise<PluginVersion[]> {
    const url = new URL(`${API}/project/${encodeURIComponent(projectId)}/version`);

    if (loader) {
      url.searchParams.set('loaders', JSON.stringify([loader]));
    }

    if (gameVersion) {
      url.searchParams.set('game_versions', JSON.stringify([gameVersion]));
    }

    const body = await this.get<
      {
        id: string;
        name: string;
        version_number: string;
        game_versions: string[];
        loaders: string[];
        date_published: string;
        files: {
          filename: string;
          url: string;
          size: number;
          primary: boolean;
          hashes?: { sha512?: string };
        }[];
      }[]
    >(url);

    return body
      .map((version) => {
        // A version can carry several files — a jar, its sources, a javadoc.
        // `primary` is the one to install; when nothing is marked, the first is
        // what Modrinth's own interface offers.
        const file = version.files.find((candidate) => candidate.primary) ?? version.files[0];

        if (!file) {
          return null;
        }

        return {
          versionId: version.id,
          name: version.name,
          versionNumber: version.version_number,
          gameVersions: version.game_versions,
          loaders: version.loaders,
          datePublished: version.date_published,
          file: {
            filename: file.filename,
            url: file.url,
            sizeBytes: file.size,
            sha512: file.hashes?.sha512 ?? null,
          },
        };
      })
      .filter((version): version is PluginVersion => version !== null);
  }

  /** One version, resolved for installation. */
  async version(versionId: string): Promise<PluginVersion> {
    const body = await this.get<{
      id: string;
      name: string;
      version_number: string;
      game_versions: string[];
      loaders: string[];
      date_published: string;
      files: {
        filename: string;
        url: string;
        size: number;
        primary: boolean;
        hashes?: { sha512?: string };
      }[];
    }>(new URL(`${API}/version/${encodeURIComponent(versionId)}`));

    const file = body.files.find((candidate) => candidate.primary) ?? body.files[0];

    if (!file) {
      throw new NotFoundException('This version carries no file to install.');
    }

    return {
      versionId: body.id,
      name: body.name,
      versionNumber: body.version_number,
      gameVersions: body.game_versions,
      loaders: body.loaders,
      datePublished: body.date_published,
      file: {
        filename: file.filename,
        url: file.url,
        sizeBytes: file.size,
        sha512: file.hashes?.sha512 ?? null,
      },
    };
  }

  private async get<T>(url: URL): Promise<T> {
    let response: Response;

    try {
      response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error: unknown) {
      // Named for what it is: the catalogue being down is not the operator's
      // panel being broken, and the message decides which of the two they go
      // looking at.
      this.logger.warn(`Modrinth unreachable: ${String(error)}`);
      throw new BadGatewayException('The plugin catalogue is unreachable.');
    }

    if (response.status === 404) {
      throw new NotFoundException('This project or version does not exist in the catalogue.');
    }

    if (!response.ok) {
      this.logger.warn(`Modrinth answered ${response.status} on ${url.pathname}`);
      throw new BadGatewayException(`The plugin catalogue answered ${response.status}.`);
    }

    return (await response.json()) as T;
  }
}
