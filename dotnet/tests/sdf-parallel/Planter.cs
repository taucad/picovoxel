// SPDX-License-Identifier: Apache-2.0
// The Twisted Gyroid Planter's own source, as an author wrote it (Brain research
// picogk-browser-slow-load-callback-path.md, Appendix A), without its top-level Library.Go call.
// Its fields are refused by the source-pattern tape lifter; the purity walk must admit them.
using System.ComponentModel.DataAnnotations;
using System.Numerics;
using PicoGK;

namespace PicoVoxel.Tests.Planter;

// Twisted Gyroid Planter: a 60°-twisted rounded-hexagon pot whose solid soil wall is wrapped
// in a gyroid lattice skin, with a matching drip saucer. Millimetres, Z up.



public enum PlanterLayout
{
  [Display(Name = "Assembled")] Assembled,
  [Display(Name = "Print Plate")] PrintPlate,
}

public static class Params
{
  [Range(0.2, 2.0)]
  [Display(Name = "Voxel Size", Description = "OpenVDB voxel size in millimetres", Order = 0)]
  public static float VoxelSizeMm { get; set; } = 0.5f;

  [Display(Name = "Layout", Description = "Assembled view or both parts flat on the print bed", Order = 1)]
  public static PlanterLayout Layout { get; set; } = PlanterLayout.Assembled;

  [Display(Name = "Show Saucer", Order = 2)]
  public static bool ShowSaucer { get; set; } = true;

  [Range(80.0, 200.0)]
  [Display(Name = "Pot Height", Description = "Overall pot height in millimetres", Order = 3)]
  public static float PotHeightMm { get; set; } = 130f;

  [Range(50.0, 150.0)]
  [Display(Name = "Base Across Flats", Description = "Outer hexagon width across flats at the base, mm", Order = 4)]
  public static float BaseAcrossFlatsMm { get; set; } = 80f;

  [Range(50.0, 180.0)]
  [Display(Name = "Top Across Flats", Description = "Outer hexagon width across flats at the rim, mm", Order = 5)]
  public static float TopAcrossFlatsMm { get; set; } = 112f;

  [Range(0.0, 180.0)]
  [Display(Name = "Twist", Description = "Twist of the hexagon from base to rim, degrees", Order = 6)]
  public static float TwistDeg { get; set; } = 60f;

  [Range(8.0, 24.0)]
  [Display(Name = "Gyroid Cell", Description = "Gyroid lattice period, mm", Order = 7)]
  public static float GyroidCellMm { get; set; } = 12f;

  [Range(1.0, 3.0)]
  [Display(Name = "Gyroid Sheet", Description = "Gyroid sheet thickness, mm", Order = 8)]
  public static float GyroidSheetMm { get; set; } = 1.6f;
}

public static class Dim
{
  public const float CornerR = 8f;          // vertical corner rounding of the pot
  public const float Skin = 6f;             // gyroid skin depth
  public const float Wall = 2.4f;           // solid soil wall
  public const float Floor = 5f;            // pot floor thickness
  public const float BaseBand = 10f;        // solid band at the base
  public const float Rim = 6f;              // solid rim band
  public const float Ramp = 8f;             // gyroid thickening below the rim (closes voids without bridges)
  public const float GrooveW = 6f, GrooveD = 2f;
  public const float SaucerGap = 3f, SaucerWall = 2.4f, SaucerFloor = 2.4f, SaucerH = 16f;

  public static float A0 => Params.BaseAcrossFlatsMm / 2f;
  public static float A1 => Params.TopAcrossFlatsMm / 2f;
  public static float SaucerA => A0 + SaucerGap + SaucerWall;
  public static float SaucerR => CornerR + SaucerGap + SaucerWall;
  public static float TopCornerReach => (A1 - CornerR) / 0.8660254f + CornerR;
  public static float SaucerCornerReach => (SaucerA - SaucerR) / 0.8660254f + SaucerR;
}

public static class Sdf
{
  // Exact 2D hexagon (flats at ±y, vertices on x) with apothem a and corner radius r.
  public static float Hex(Vector2 p, float a, float r)
  {
    float ri = a - r;
    p = Vector2.Abs(p);
    float d = MathF.Min(-0.866025404f * p.X + 0.5f * p.Y, 0f);
    p -= 2f * d * new Vector2(-0.866025404f, 0.5f);
    p -= new Vector2(Math.Clamp(p.X, -0.577350269f * ri, 0.577350269f * ri), ri);
    return p.Length() * MathF.Sign(p.Y) - r;
  }

  public static float RoundInter(float a, float b, float r)
  {
    var u = Vector2.Max(new Vector2(r + a, r + b), Vector2.Zero);
    return MathF.Min(-r, MathF.Max(a, b)) + u.Length();
  }

  public static Vector2 Rot(Vector2 p, float ang)
  {
    float c = MathF.Cos(ang), s = MathF.Sin(ang);
    return new Vector2(c * p.X - s * p.Y, s * p.X + c * p.Y);
  }
}

public sealed class PotField : IBoundedImplicit
{
  readonly float z0, zTop, h, twist, k, halfSheet;
  readonly Vector2[] holes;
  readonly Vector2[] grooveDirs;

  public PotField(float baseZ)
  {
    z0 = baseZ;
    h = Params.PotHeightMm;
    zTop = z0 + h;
    twist = Params.TwistDeg * MathF.PI / 180f;
    k = 2f * MathF.PI / Params.GyroidCellMm;
    halfSheet = Params.GyroidSheetMm / 2f;

    // Drainage: centre hole plus six on the groove lines toward the hexagon flats.
    holes = new Vector2[7];
    grooveDirs = new Vector2[6];
    holes[0] = Vector2.Zero;
    for (int i = 0; i < 6; i++)
    {
      float a = (30f + 60f * i) * MathF.PI / 180f;
      grooveDirs[i] = new Vector2(MathF.Cos(a), MathF.Sin(a));
      holes[i + 1] = grooveDirs[i] * 18f;
    }

    float reach = MathF.Max(Dim.TopCornerReach, (Dim.A0 - Dim.CornerR) / 0.8660254f + Dim.CornerR) + 2f;
    oBounds = new BBox3(-reach, -reach, z0 - 1f, reach, reach, zTop + 1f);
  }

  public BBox3 oBounds { get; }

  public float fSignedDistance(in Vector3 p)
  {
    float t = (p.Z - z0) / h;
    float apothem = Dim.A0 + (Dim.A1 - Dim.A0) * t;
    Vector2 q = Sdf.Rot(new Vector2(p.X, p.Y), -twist * t);
    float dOut = Sdf.Hex(q, apothem, Dim.CornerR);

    // Outer envelope with rounded rim edge and a small bed-edge radius.
    float env = Sdf.RoundInter(dOut, z0 - p.Z, 1f);
    env = Sdf.RoundInter(env, p.Z - zTop, 2f);

    // Soil cavity with a filleted floor.
    float floorTop = z0 + Dim.Floor;
    float cav = Sdf.RoundInter(dOut + Dim.Skin + Dim.Wall, floorTop - p.Z, 4f);

    // Gyroid skin: void between sheets, inside the skin band only. Sheets thicken under the rim.
    float zLo = z0 + Dim.BaseBand, zHi = zTop - Dim.Rim;
    float body = env;
    if (dOut > -Dim.Skin - 1f && p.Z > zLo - 1f && p.Z < zHi + 1f)
    {
      float x = q.X * k, y = q.Y * k, z = p.Z * k;
      float g = MathF.Sin(x) * MathF.Cos(y) + MathF.Sin(y) * MathF.Cos(z) + MathF.Sin(z) * MathF.Cos(x);
      float s = Math.Clamp((p.Z - (zHi - Dim.Ramp)) / Dim.Ramp, 0f, 1f);
      float sheet = MathF.Abs(g) / (k * 1.3f) - (halfSheet + 3f * s * s);
      float voidD = MathF.Max(MathF.Max(-(dOut + Dim.Skin), -sheet), MathF.Max(zLo - p.Z, p.Z - zHi));
      body = MathF.Max(body, -voidD);
    }

    body = Sdf.RoundInter(body, -cav, 1.2f);

    // Underside drainage grooves (6 mm bridges) and drain holes.
    Vector2 xy = new(p.X, p.Y);
    float groove = float.MaxValue;
    foreach (var d in grooveDirs)
    {
      float u = Vector2.Dot(xy, d);
      float v = MathF.Abs(d.X * p.Y - d.Y * p.X);
      groove = MathF.Min(groove, MathF.Max(v - Dim.GrooveW / 2f, -u));
    }
    groove = MathF.Max(groove, p.Z - (z0 + Dim.GrooveD));

    float hole = (xy - holes[0]).Length() - 4f;
    for (int i = 1; i < holes.Length; i++)
      hole = MathF.Min(hole, (xy - holes[i]).Length() - 2.5f);
    hole = MathF.Max(hole, p.Z - (floorTop + 1f));

    return MathF.Max(body, -MathF.Min(groove, hole));
  }
}

public sealed class SaucerField : IBoundedImplicit
{
  readonly Vector2 c;

  public SaucerField(float centerX)
  {
    c = new Vector2(centerX, 0f);
    float reach = Dim.SaucerCornerReach + 1f;
    oBounds = new BBox3(centerX - reach, -reach, -1f, centerX + reach, reach, Dim.SaucerH + 1f);
  }

  public BBox3 oBounds { get; }

  public float fSignedDistance(in Vector3 p)
  {
    float dS = Sdf.Hex(new Vector2(p.X, p.Y) - c, Dim.SaucerA, Dim.SaucerR);
    float outer = Sdf.RoundInter(dS, -p.Z, 0.8f);
    outer = Sdf.RoundInter(outer, p.Z - Dim.SaucerH, 1f);
    float inner = Sdf.RoundInter(dS + Dim.SaucerWall, Dim.SaucerFloor - p.Z, 3f);
    return Sdf.RoundInter(outer, -inner, 1f);
  }
}
