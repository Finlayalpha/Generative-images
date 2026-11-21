import type { LatLon } from '../data/overpass';
import type { Tags } from '../rules/engine';

/**
 * Council parking data, normalised so every council adapter produces the same
 * thing. Bay rules are expressed as tags the rules engine already understands
 * (fee, access, restriction, maxstay and their :conditional forms), so the
 * engine needs no council-specific code.
 */
export interface CouncilBay {
  id: string;
  council: string;
  geometry: LatLon[];
  /** Engine tags, e.g. { fee: 'no', 'fee:conditional': 'yes @ (Mo-Fr 08:30-18:30)' }. */
  tags: Tags;
  /** Human-readable summary from the council's own fields. */
  description: string;
  road?: string;
  zone?: string;
  spaces?: number;
  lengthM?: number;
  /** The council's hours couldn't be read, so the restriction is assumed to apply at all times. */
  uncertain?: boolean;
  /** Live status, where the council publishes it. */
  suspension?: 'suspended' | 'planned';
}

/** A controlled parking zone: outside bays, kerbs are single yellow lines during `hours`. */
export interface CouncilZone {
  code: string;
  name: string;
  council: string;
  /** opening_hours syntax, or null if unknown. */
  hours: string | null;
  /** Polygon rings, outer first. */
  polygon: LatLon[][];
}

export interface CouncilInfo {
  id: string;
  name: string;
  /** Licence attribution that must be shown with the data. */
  attribution: string;
}

export interface CouncilData {
  councils: CouncilInfo[];
  bays: CouncilBay[];
  zones: CouncilZone[];
}

export const EMPTY_COUNCIL_DATA: CouncilData = { councils: [], bays: [], zones: [] };
