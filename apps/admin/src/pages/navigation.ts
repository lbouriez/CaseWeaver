export interface NavigationSection {
  readonly path: string;
  readonly label: string;
  readonly kicker: string;
  readonly permissions: readonly string[];
}

export const navigationSections: readonly NavigationSection[] = [
  { path: "/", label: "Overview", kicker: "00 / pulse", permissions: [] },
  {
    path: "/integrations",
    label: "Integrations",
    kicker: "01 / sources",
    permissions: ["configuration.read"],
  },
  {
    path: "/ai",
    label: "AI",
    kicker: "02 / inference",
    permissions: ["configuration.read"],
  },
  {
    path: "/knowledge-analysis",
    label: "Knowledge & Analysis",
    kicker: "03 / evidence",
    permissions: ["analysis.read"],
  },
  {
    path: "/publication",
    label: "Publication",
    kicker: "04 / release",
    permissions: ["analysis.read"],
  },
  {
    path: "/operations",
    label: "Operations",
    kicker: "05 / recovery",
    permissions: [
      "operations.inspect",
      "cost.read",
      "audit.read",
      "retention.run",
    ],
  },
  {
    path: "/access",
    label: "Access",
    kicker: "06 / authority",
    permissions: ["workspace.manage", "identity.manage"],
  },
  {
    path: "/platform",
    label: "Platform",
    kicker: "07 / foundation",
    permissions: ["configuration.read"],
  },
];

export function visibleNavigation(
  permissions: readonly string[] | undefined,
): readonly NavigationSection[] {
  const effectivePermissions = new Set(permissions ?? []);
  return navigationSections.filter(
    (section) =>
      section.permissions.length === 0 ||
      section.permissions.some((permission) =>
        effectivePermissions.has(permission),
      ),
  );
}
