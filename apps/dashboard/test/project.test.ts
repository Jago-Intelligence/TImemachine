import { expect, test } from 'vitest';
import { selectProject, projectOverview } from '../src/lib/project';
const a = { id: 'a', name: 'Alpha', service: 'alpha-api' };
const b = { id: 'b', name: 'Beta', service: 'beta-api' };
test('selects only a current membership and falls back safely after removal', () => {
  expect(selectProject([a, b], 'b')).toBe(b);
  expect(selectProject([a], 'b')).toBe(a);
  expect(selectProject([a, b], 'forged-project')).toBe(a);
  expect(selectProject([], 'a')).toBeUndefined();
});
test('project settings show only the selected project, its members and its tokens', () => {
  const value = {
    projects: [a, b],
    users: [
      { role: 'admin', projects: [] },
      { role: 'developer', projects: ['a'] },
      { role: 'developer', projects: ['b'] },
    ],
    tokens: [{ projectId: 'a' }, { projectId: 'b' }],
  };
  const view = projectOverview(value, a);
  expect(view.projects).toEqual([a]);
  expect(view.users).toEqual(value.users.slice(0, 2));
  expect(view.tokens).toEqual([{ projectId: 'a' }]);
  expect(projectOverview(value).projects).toEqual([]);
  expect(projectOverview(value).tokens).toEqual([]);
});
