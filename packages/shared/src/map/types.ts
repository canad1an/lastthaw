export type Terrain =
  | "plains"
  | "forest"
  | "hills"
  | "mountains"
  | "desert"
  | "tundra"
  | "wetland";

export type ResourceKind =
  | "fertile_soil"
  | "timber"
  | "flint"
  | "fish"
  | "copper"
  | "tin"
  | "iron"
  | "horses"
  | "salt"
  | "furs"
  | "gold"
  | "obsidian"
  | "stone_quarry";

export interface MapRegion {
  /** Stable id: `${countryIso2Lower}-${slug}`. */
  id: string;
  name: string;
  /** ISO 3166-1 alpha-2, lower case (or a 3-letter NE code for odd territories). */
  country: string;
  countryName: string;
  terrain: Terrain;
  coastal: boolean;
  river: boolean;
  resources: ResourceKind[];
  /** Spherical centroid. */
  lat: number;
  lon: number;
  /** Projected centroid in the 2000 x 1000 equirectangular viewBox. */
  x: number;
  y: number;
  areaKm2: number;
  /** Region value, normalised so the mean over all regions is 1.0. */
  value: number;
  /** Ids of regions sharing a land border. */
  neighbors: string[];
  /** Ids of regions reachable by a sea route. */
  seaRoutes: string[];
  /** SVG path `d` string in the 2000 x 1000 viewBox. */
  path: string;
}

export interface WorldMap {
  version: 1;
  width: 2000;
  height: 1000;
  generatedAt: string;
  regions: MapRegion[];
}
