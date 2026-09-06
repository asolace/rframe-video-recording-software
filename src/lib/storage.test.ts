import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Project } from "../types";
import {
  deleteFolder,
  deleteProject,
  getProjectBlob,
  listFolders,
  listProjects,
  saveFolder,
  saveProject,
} from "./storage";

const makeProject = (id: string, folderId: string | null = null): Project => ({
  id,
  folderId,
  name: id,
  createdAt: 1,
  updatedAt: 2,
  duration: 10,
  thumbnail: "data:image/jpeg;base64,preview",
  mimeType: "video/webm",
  size: 3,
  width: 1920,
  height: 1080,
  mode: "screen",
  favorite: false,
  edits: {
    clips: [{ id: "clip", start: 0, end: 10 }],
    muted: false,
    volume: 1,
    title: "",
    aspectRatio: "original",
  },
});

beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("frame-studio");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
});

describe("local video storage", () => {
  it("persists metadata and video independently across database connections", async () => {
    const project = makeProject("recording");
    await saveProject(project, new Blob(["abc"], { type: "video/webm" }));
    expect(await listProjects()).toEqual([project]);
    expect(await (await getProjectBlob(project.id))?.text()).toBe("abc");
    const edited = {
      ...project,
      name: "Edited title",
      edits: { ...project.edits, muted: true },
    };
    await saveProject(edited);
    expect(await listProjects()).toEqual([edited]);
    expect(await (await getProjectBlob(project.id))?.text()).toBe("abc");
  });

  it("rolls back project metadata when the video write fails", async () => {
    const project = makeProject("recording");
    await saveProject(project, new Blob(["original"]));
    // A non-cloneable payload exercises synchronous IndexedDB write failure.
    const invalidBlob = { uncloneable: () => undefined } as unknown as Blob;
    await expect(
      saveProject({ ...project, name: "Must not be committed" }, invalidBlob),
    ).rejects.toThrow();
    expect((await listProjects())[0].name).toBe("recording");
    expect(await (await getProjectBlob(project.id))?.text()).toBe("original");
  });

  it("deletes metadata and its video together", async () => {
    await saveProject(makeProject("delete-me"), new Blob(["abc"]));
    await saveProject(makeProject("keep-me"), new Blob(["def"]));
    await deleteProject("delete-me");
    expect((await listProjects()).map(({ id }) => id)).toEqual(["keep-me"]);
    expect(await getProjectBlob("delete-me")).toBeUndefined();
    expect(await (await getProjectBlob("keep-me"))?.text()).toBe("def");
  });

  it("removes a folder and preserves all its recordings in the root workspace", async () => {
    await saveFolder({
      id: "tutorials",
      name: "Tutorials",
      color: "#fff",
      createdAt: 1,
    });
    await saveFolder({
      id: "personal",
      name: "Personal",
      color: "#000",
      createdAt: 2,
    });
    await saveProject(makeProject("one", "tutorials"), new Blob(["one"]));
    await saveProject(makeProject("two", "tutorials"), new Blob(["two"]));
    await saveProject(makeProject("three", "personal"), new Blob(["three"]));
    await deleteFolder("tutorials");
    expect((await listFolders()).map(({ id }) => id)).toEqual(["personal"]);
    const projects = await listProjects();
    expect(projects.find(({ id }) => id === "one")?.folderId).toBeNull();
    expect(projects.find(({ id }) => id === "two")?.folderId).toBeNull();
    expect(projects.find(({ id }) => id === "three")?.folderId).toBe(
      "personal",
    );
    expect(await (await getProjectBlob("one"))?.text()).toBe("one");
    expect(await (await getProjectBlob("two"))?.text()).toBe("two");
  });

  it("starts with an empty workspace and sorts recordings by last update", async () => {
    expect(await listFolders()).toEqual([]);
    expect(await listProjects()).toEqual([]);
    await saveProject({ ...makeProject("older"), updatedAt: 10 });
    await saveProject({ ...makeProject("newer"), updatedAt: 20 });
    expect((await listProjects()).map(({ id }) => id)).toEqual([
      "newer",
      "older",
    ]);
  });
});
