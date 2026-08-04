import { describe, expect, it } from 'vitest';
import {
  calculateCpuPercent,
  calculateMemoryBytes,
  calculateNetwork,
  emptyUsage,
  type DockerStats,
} from './stats.js';

/**
 * Les relevés Docker sont des compteurs cumulés depuis le démarrage : les
 * valeurs de référence ci-dessous sont donc volontairement non nulles. Un zéro
 * en `precpu_stats.system_cpu_usage` signale au contraire l'absence de relevé
 * précédent, ce que le calcul traite à part.
 */
function sample(overrides: {
  cpu: number;
  previousCpu: number;
  system: number;
  previousSystem: number;
  cores?: number;
}): DockerStats {
  return {
    cpu_stats: {
      cpu_usage: { total_usage: overrides.cpu },
      system_cpu_usage: overrides.system,
      online_cpus: overrides.cores,
    },
    precpu_stats: {
      cpu_usage: { total_usage: overrides.previousCpu },
      system_cpu_usage: overrides.previousSystem,
    },
  };
}

describe('calculateCpuPercent', () => {
  it('exprime 100 % pour un cœur entièrement consommé', () => {
    // 1 ms de CPU conteneur sur 8 ms de CPU machine, 8 cœurs : un cœur plein.
    const stats = sample({
      cpu: 2_000_000,
      previousCpu: 1_000_000,
      system: 16_000_000,
      previousSystem: 8_000_000,
      cores: 8,
    });

    expect(calculateCpuPercent(stats)).toBe(100);
  });

  // Sur une machine à 16 cœurs, un serveur qui en occupe deux doit afficher
  // 200, pas 12,5 : c'est ce que l'opérateur compare à sa limite CPU.
  it('dépasse 100 % au-delà d’un cœur', () => {
    const stats = sample({
      cpu: 3_000_000,
      previousCpu: 1_000_000,
      system: 16_000_000,
      previousSystem: 8_000_000,
      cores: 8,
    });

    expect(calculateCpuPercent(stats)).toBe(200);
  });

  // Le premier relevé n'a pas de précédent : Docker envoie des `precpu_stats`
  // à zéro. Sans ce cas particulier, on comparerait le temps CPU du conteneur
  // depuis son lancement au temps CPU de la machine depuis son démarrage, ce
  // qui ressemble à un pourcentage sans en être un.
  it('retourne 0 au premier relevé, faute de précédent', () => {
    const stats: DockerStats = {
      cpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 8_000_000 },
      precpu_stats: {},
    };

    expect(calculateCpuPercent(stats)).toBe(0);
  });

  it('retourne 0 quand Docker envoie un précédent à zéro', () => {
    const stats = sample({
      cpu: 1_000_000,
      previousCpu: 0,
      system: 8_000_000,
      previousSystem: 0,
      cores: 8,
    });

    expect(calculateCpuPercent(stats)).toBe(0);
  });

  it('retourne 0 sur des relevés identiques', () => {
    const stats = sample({
      cpu: 500,
      previousCpu: 500,
      system: 1000,
      previousSystem: 1000,
      cores: 4,
    });

    expect(calculateCpuPercent(stats)).toBe(0);
  });

  it('ne plante pas sur une réponse incomplète', () => {
    expect(calculateCpuPercent({})).toBe(0);
  });

  it('déduit le nombre de cœurs de percpu_usage à défaut', () => {
    const stats: DockerStats = {
      cpu_stats: {
        cpu_usage: { total_usage: 2_000_000, percpu_usage: [1, 2, 3, 4] },
        system_cpu_usage: 8_000_000,
      },
      precpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 4_000_000 },
    };

    expect(calculateCpuPercent(stats)).toBe(100);
  });
});

describe('calculateMemoryBytes', () => {
  // Sans cette soustraction, un serveur affiche « 100 % de RAM » dès qu'il a lu
  // sa map, alors que le noyau libérerait ce cache à la moindre pression.
  it('retire le cache de pages réclamable (cgroup v2)', () => {
    const stats: DockerStats = {
      memory_stats: { usage: 4 * 1024 ** 3, stats: { inactive_file: 1024 ** 3 } },
    };

    expect(calculateMemoryBytes(stats)).toBe(3 * 1024 ** 3);
  });

  it('retire le cache (cgroup v1)', () => {
    const stats: DockerStats = {
      memory_stats: { usage: 2 * 1024 ** 3, stats: { cache: 512 * 1024 ** 2 } },
    };

    expect(calculateMemoryBytes(stats)).toBe(2 * 1024 ** 3 - 512 * 1024 ** 2);
  });

  it('retourne l’usage brut sans détail de cache', () => {
    expect(calculateMemoryBytes({ memory_stats: { usage: 1000 } })).toBe(1000);
  });

  it('ne descend jamais sous zéro', () => {
    const stats: DockerStats = { memory_stats: { usage: 100, stats: { cache: 500 } } };
    expect(calculateMemoryBytes(stats)).toBe(0);
  });

  it('ne plante pas sur une réponse vide', () => {
    expect(calculateMemoryBytes({})).toBe(0);
  });
});

describe('calculateNetwork', () => {
  it('additionne toutes les interfaces', () => {
    const stats: DockerStats = {
      networks: {
        eth0: { rx_bytes: 100, tx_bytes: 200 },
        eth1: { rx_bytes: 50, tx_bytes: 25 },
      },
    };

    expect(calculateNetwork(stats)).toEqual({ rx: 150, tx: 225 });
  });

  it('retourne zéro sans interface', () => {
    expect(calculateNetwork({})).toEqual({ rx: 0, tx: 0 });
  });
});

describe('emptyUsage', () => {
  it('rapporte un relevé nul porteur de l’état', () => {
    const usage = emptyUsage('offline');

    expect(usage.state).toBe('offline');
    expect(usage.cpuPercent).toBe(0);
    expect(usage.memoryBytes).toBe(0);
    expect(usage.uptime).toBe(0);
  });
});
