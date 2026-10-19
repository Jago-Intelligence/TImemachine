export type Project = { id: string; name: string; service: string };
export const PROJECT_COOKIE = 'timemachine_project';
/** A preference never grants access: resolve it against fresh server membership. */
export function selectProject(projects: readonly Project[], preferred?: string) {
  return projects.find((project) => project.id === preferred) ?? projects[0];
}
export function projectOverview<
  T extends {
    projects: Project[];
    users: { role: string; projects: string[] }[];
    tokens: { projectId: string }[];
  },
>(value: T, selected?: Project): T {
  return {
    ...value,
    projects: selected
      ? value.projects.filter((project) => project.id === selected.id)
      : [],
    users: selected
      ? value.users.filter(
          (user) => user.role === 'admin' || user.projects.includes(selected.id),
        )
      : value.users.filter((user) => user.role === 'admin'),
    tokens: selected
      ? value.tokens.filter((token) => token.projectId === selected.id)
      : [],
  };
}
