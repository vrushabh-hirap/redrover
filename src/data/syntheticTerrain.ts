import { TerrainData, TerrainCell } from '../core/types';

/**
 * Procedurally generates a synthetic Mars terrain (e.g., Jezero crater analogue)
 * with dunes, impact craters, and rocky ridges.
 * Marked as SYNTHETIC FALLBACK - NOT NASA DATA.
 */
export function generateSyntheticMarsTerrain(
  width = 64,
  height = 64,
  resolution = 2.0
): TerrainData {
  const cells: TerrainCell[][] = [];
  let minElev = Infinity;
  let maxElev = -Infinity;

  // Primary elevation field: subtle rolling dunes + impact basins
  const rawElevations: number[][] = [];

  for (let y = 0; y < height; y++) {
    rawElevations[y] = [];
    for (let x = 0; x < width; x++) {
      // Normalize coordinates to 0..1
      const nx = x / width;
      const ny = y / height;

      // Base gentle regional slope
      const basePlane = (nx * 3.0) - (ny * 1.5);

      // Gentle rolling Martian dunes (moderate wavelength)
      const wave1 = Math.sin(nx * Math.PI * 4) * Math.cos(ny * Math.PI * 4) * 1.5;
      const wave2 = Math.sin((nx + ny) * Math.PI * 3) * 1.0;

      // Subtle surface ripples
      const ripples = Math.sin(x * 0.5) * 0.2 + Math.cos(y * 0.5) * 0.2;

      let elev = basePlane + wave1 + wave2 + ripples;

      // Impact crater near (0.45, 0.55)
      const cx = width * 0.45;
      const cy = height * 0.55;
      const distC = Math.hypot(x - cx, y - cy);
      const craterRadius = width * 0.18;

      if (distC < craterRadius) {
        if (distC < craterRadius * 0.7) {
          // Inner bowl
          elev -= (craterRadius * 0.7 - distC) * 0.8;
        } else {
          // Elevated rim
          const rimT = (distC - craterRadius * 0.7) / (craterRadius * 0.3);
          elev += Math.sin(rimT * Math.PI) * 2.5;
        }
      }

      // Rocky mound near (0.75, 0.3)
      const rx = width * 0.75;
      const ry = height * 0.3;
      const distM = Math.hypot(x - rx, y - ry);
      const moundRadius = width * 0.14;
      if (distM < moundRadius) {
        elev += Math.cos((distM / moundRadius) * (Math.PI / 2)) * 3.5;
      }

      rawElevations[y][x] = elev;
      if (elev < minElev) minElev = elev;
      if (elev > maxElev) maxElev = elev;
    }
  }

  // Calculate slopes and identify hazards
  const MAX_TRAVERSABLE_SLOPE = 24; // degrees

  for (let y = 0; y < height; y++) {
    cells[y] = [];
    for (let x = 0; x < width; x++) {
      const currentElev = rawElevations[y][x];

      // Central difference or single side slope calculation
      const dx1 = x > 0 ? rawElevations[y][x - 1] : currentElev;
      const dx2 = x < width - 1 ? rawElevations[y][x + 1] : currentElev;
      const dy1 = y > 0 ? rawElevations[y - 1][x] : currentElev;
      const dy2 = y < height - 1 ? rawElevations[y + 1][x] : currentElev;

      const gradX = (dx2 - dx1) / (2 * resolution);
      const gradY = (dy2 - dy1) / (2 * resolution);
      const gradMagnitude = Math.sqrt(gradX * gradX + gradY * gradY);
      const slopeDeg = (Math.atan(gradMagnitude) * 180) / Math.PI;

      // Roughness proxy
      const roughness = Math.min(1.0, Math.max(0.05, (slopeDeg / 30) * 0.8 + (Math.sin(x * 1.5 + y * 2) * 0.1)));

      let isHazard = false;
      let hazardType: TerrainCell['hazardType'] = undefined;

      // Boulder field near mound
      const rx = width * 0.75;
      const ry = height * 0.3;
      const distM = Math.hypot(x - rx, y - ry);

      // Sand trap near center of crater
      const cx = width * 0.45;
      const cy = height * 0.55;
      const distC = Math.hypot(x - cx, y - cy);

      if (slopeDeg > MAX_TRAVERSABLE_SLOPE) {
        isHazard = true;
        hazardType = 'steep_slope';
      } else if (distM < width * 0.08 && slopeDeg > 12) {
        isHazard = true;
        hazardType = 'boulder';
      } else if (distC < width * 0.06) {
        isHazard = true;
        hazardType = 'sand_trap';
      }

      // Safeguard start area (x <= 4, y <= 4) and goal area (x >= width - 5, y >= height - 5)
      if ((x <= 4 && y <= 4) || (x >= width - 5 && y >= height - 5)) {
        isHazard = false;
        hazardType = undefined;
      }

      cells[y][x] = {
        x,
        y,
        elevation: Number(currentElev.toFixed(2)),
        slope: Number(slopeDeg.toFixed(2)),
        roughness: Number(roughness.toFixed(2)),
        isHazard,
        hazardType,
      };
    }
  }

  return {
    width,
    height,
    resolution,
    cells,
    minElevation: Number(minElev.toFixed(2)),
    maxElevation: Number(maxElev.toFixed(2)),
    provenance: {
      source: 'SYNTHETIC_FALLBACK',
      label: 'SYNTHETIC FALLBACK – NOT NASA DATA',
      description: 'Procedural analogue terrain modeling Martian crater floor, dunes, and rocky rims. Not calibrated with NASA HiRISE/HRSC DTM.',
    },
  };
}
