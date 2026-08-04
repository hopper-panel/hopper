import { Module } from '@nestjs/common';
import { ActivityController } from './activity.controller.js';

/**
 * Lecture du journal d'audit d'un serveur.
 *
 * Aucun service : la seule opération est une lecture paginée, et l'interposer
 * derrière un service n'ajouterait qu'un fichier.
 */
@Module({ controllers: [ActivityController] })
export class ActivityModule {}
