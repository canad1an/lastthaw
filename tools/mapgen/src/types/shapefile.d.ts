declare module "shapefile" {
  import type { Feature, Geometry } from "geojson";
  export interface Source {
    read(): Promise<{ done: boolean; value: Feature<Geometry, Record<string, unknown>> }>;
  }
  export function open(shp: string, dbf?: string, options?: { encoding?: string }): Promise<Source>;
}
