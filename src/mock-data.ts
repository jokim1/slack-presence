import type { Channel, Member, Presence, WorkspaceStatus } from "./types";

export const mockWorkspaces: WorkspaceStatus[] = [
  {
    teamId: "T_DEMO",
    teamName: "Acme Studio",
    connected: true,
    selectedChannelId: "C_DESIGN",
  },
  {
    teamId: "T_NIMBUS",
    teamName: "Nimbus Labs",
    connected: true,
    selectedChannelId: "C_PLATFORM",
  },
];

export const mockChannelsByTeam: Record<string, Channel[]> = {
  T_DEMO: [
    { id: "C_DESIGN", name: "design", isPrivate: false },
    { id: "C_PRODUCT", name: "product", isPrivate: false },
    { id: "G_LAUNCH", name: "launch-room", isPrivate: true },
  ],
  T_NIMBUS: [
    { id: "C_PLATFORM", name: "platform", isPrivate: false },
    { id: "C_RELEASES", name: "releases", isPrivate: false },
    { id: "G_ONCALL", name: "oncall", isPrivate: true },
  ],
};

const acmePeople = [
  ["U_MAYA", "Maya Chen", "Product Designer", "active"],
  ["U_JONAH", "Jonah Reed", "Staff Engineer", "active"],
  ["U_AMARA", "Amara Okafor", "Product Lead", "away"],
  ["U_LEO", "Leo Martins", "Frontend Engineer", "active"],
  ["U_SOFIA", "Sofia Park", "Research", "away"],
  ["U_NOAH", "Noah Williams", "Design Engineer", "away"],
] as const;

const nimbusPeople = [
  ["U_PRIYA", "Priya Raman", "Platform Engineer", "active"],
  ["U_DIEGO", "Diego Alvarez", "SRE", "active"],
  ["U_HANA", "Hana Sato", "Release Manager", "away"],
  ["U_TOMAS", "Tomas Berg", "Infra Engineer", "away"],
] as const;

type PersonSeed = readonly [string, string, string, string];

function makeMember([id, displayName, title, presence]: PersonSeed): Member {
  return { id, displayName, title, presence: presence as Presence, avatarUrl: "" };
}

export const mockMembersByChannel: Record<string, Member[]> = {
  C_DESIGN: acmePeople.map(makeMember),
  C_PRODUCT: acmePeople.slice(0, 5).map(makeMember),
  G_LAUNCH: [acmePeople[0], acmePeople[1], acmePeople[3]].map(makeMember),
  C_PLATFORM: nimbusPeople.map(makeMember),
  C_RELEASES: nimbusPeople.slice(0, 3).map(makeMember),
  G_ONCALL: [nimbusPeople[0], nimbusPeople[1]].map(makeMember),
};

export function mockPresence(userId: string): PresenceReplyLike {
  const secondBucket = Math.floor(Date.now() / 30_000);
  const checksum = [...userId].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return {
    userId,
    presence: (checksum + secondBucket) % 4 === 0 ? "away" : "active",
  };
}

interface PresenceReplyLike {
  userId: string;
  presence: Presence;
}
