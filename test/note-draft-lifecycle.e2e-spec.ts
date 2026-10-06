import { randomUUID } from 'crypto';
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { PrismaService } from 'src/prisma/prisma.service';
import { NoteService } from 'src/note/note.service';
import { UploadService } from 'src/upload/upload.service';
import { getE2eApp } from './e2e-context';

const canRun =
  process.env.NODE_ENV === 'test' &&
  Boolean(process.env.SECRET) &&
  /(^|[_-])test($|[_-])/i.test(
    new URL(
      process.env.DATABASE_URL || 'postgresql://localhost/disabled',
    ).pathname.slice(1),
  );
const describeDatabase = canRun ? describe : describe.skip;

describeDatabase('Note draft consumption concurrency', () => {
  afterEach(() => jest.restoreAllMocks());

  async function account() {
    const app = getE2eApp();
    const prisma = app.get(PrismaService);
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    const user = await prisma.user.create({
      data: {
        accountId: `draft-${suffix}`,
        inviteCode: suffix.slice(0, 6),
        passwordHash: 'unused',
        nickname: 'Draft test',
      },
    });
    const token = app.get(JwtService).sign(
      { sub: user.id, accountId: user.accountId, role: 'USER', aud: 'APP' },
      {
        secret:
          app.get(ConfigService).get<string>('SECRET') ?? process.env.SECRET,
        expiresIn: '5m',
      },
    );
    return {
      app,
      prisma,
      user,
      token,
      service: app.get(NoteService),
      http: request(app.getHttpServer()),
    };
  }

  function body(response: request.Response) {
    return response.body.data ?? response.body;
  }

  function mockMedia(context: Awaited<ReturnType<typeof account>>) {
    const base = 'https://storage.test/bucket';
    (context.service as any).storagePublicObjectBases = [base];
    const upload = context.app.get(UploadService);
    jest
      .spyOn(upload, 'objectKeyFromPublicUrl')
      .mockImplementation((url) =>
        typeof url === 'string' && url.startsWith(`${base}/`)
          ? url.slice(base.length + 1).split('?')[0]
          : null,
      );
    const signer = jest
      .spyOn(upload, 'createPresignedGetUrl')
      .mockImplementation(async (key) => ({
        expiresAt: new Date(Date.now() + 7200_000),
        url: `https://signed.test/${key}?signature=fresh`,
      }));
    return { base, signer };
  }

  function publicationRequest(
    context: Awaited<ReturnType<typeof account>>,
    action: 'create' | 'update',
    id: string | undefined,
    input: Record<string, unknown>,
  ) {
    return () =>
      (action === 'create'
        ? context.http.post('/api/v1/note')
        : context.http.patch(`/api/v1/note/${id}`)
      )
        .set('Authorization', `Bearer ${context.token}`)
        .send(input);
  }

  it('bounds never-created discard markers without losing late-save fences or published outcomes', async () => {
    const { http, token, prisma, user, service } = await account();
    await service.saveNoteDraft(user.id, 'active-delete', {
      title: 'Keep deletable',
    });
    await service.saveNoteDraft(user.id, 'active-publish', {
      title: 'Keep editable',
    });
    const input = {
      title: 'Durable result',
      media: [],
      clientDraftID: 'published-old',
    };
    const first = await http
      .post('/api/v1/note')
      .set('Authorization', `Bearer ${token}`)
      .send(input)
      .expect(201);
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await prisma.noteDraft.update({
      where: {
        ownerID_clientDraftID: {
          ownerID: user.id,
          clientDraftID: 'published-old',
        },
      },
      data: { consumedAt: old },
    });
    await prisma.noteDraft.createMany({
      data: [
        ...Array.from({ length: 998 }, (_, i) => ({
          ownerID: user.id,
          clientDraftID: `discard-${i}`,
          consumedAt: new Date(),
        })),
        { ownerID: user.id, clientDraftID: 'expired-discard', consumedAt: old },
      ],
    });
    const results = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        http
          .delete(`/api/v1/note/drafts/never-${i}`)
          .set('Authorization', `Bearer ${token}`),
      ),
    );
    expect(
      results.map((result) => result.status).sort((a, b) => a - b),
    ).toEqual([204, 204, 409]);
    expect(
      await prisma.noteDraft.count({
        where: {
          ownerID: user.id,
          consumedAt: { not: null },
          publishedNoteID: null,
        },
      }),
    ).toBe(1000);
    expect(
      await prisma.noteDraft.findFirst({
        where: { ownerID: user.id, clientDraftID: 'expired-discard' },
      }),
    ).toBeNull();
    const acceptedId = `never-${results.findIndex((result) => result.status === 204)}`;
    const marker = await prisma.noteDraft.findFirstOrThrow({
      where: { ownerID: user.id, clientDraftID: acceptedId },
    });
    await http
      .delete(`/api/v1/note/drafts/${acceptedId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    expect(
      (await prisma.noteDraft.findUniqueOrThrow({ where: { id: marker.id } }))
        .consumedAt,
    ).toEqual(marker.consumedAt);
    await http
      .put(`/api/v1/note/drafts/${acceptedId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Late save' })
      .expect(409);
    await http
      .put('/api/v1/note/drafts/new-over-quota')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'New' })
      .expect(409);
    await http
      .put('/api/v1/note/drafts/active-publish')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Updated' })
      .expect(200);
    await http
      .delete('/api/v1/note/drafts/active-delete')
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    expect(
      await prisma.noteDraft.count({
        where: {
          ownerID: user.id,
          consumedAt: { not: null },
          publishedNoteID: null,
        },
      }),
    ).toBe(1001);
    await http
      .post('/api/v1/note')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'New published result',
        media: [],
        clientDraftID: 'active-publish',
      })
      .expect(201);
    const replay = await http
      .post('/api/v1/note')
      .set('Authorization', `Bearer ${token}`)
      .send(input)
      .expect(201);
    expect(body(replay).id).toBe(body(first).id);
    await prisma.noteDraft.updateMany({
      where: {
        ownerID: user.id,
        publishedNoteID: null,
        consumedAt: { not: null },
      },
      data: { consumedAt: old },
    });
    await http
      .put('/api/v1/note/drafts/new-after-expiry')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Capacity restored' })
      .expect(200);
    expect(
      await prisma.noteDraft.count({
        where: {
          ownerID: user.id,
          consumedAt: { not: null },
          publishedNoteID: null,
        },
      }),
    ).toBe(0);
    expect(
      (
        await prisma.noteDraft.findFirstOrThrow({
          where: { ownerID: user.id, clientDraftID: 'published-old' },
        })
      ).publishedNoteID,
    ).toBe(body(first).id);
  });

  it('consumes a create draft and rejects late saves without retaining private payloads', async () => {
    const { http, token, prisma, user } = await account();
    await http
      .put('/api/v1/note/drafts/new-draft')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Draft', content: 'Private draft' })
      .expect(200);
    const published = await http
      .post('/api/v1/note')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Published', media: [], clientDraftID: 'new-draft' })
      .expect(201);
    await http
      .put('/api/v1/note/drafts/new-draft')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Late autosave' })
      .expect(409);
    await http
      .get('/api/v1/note/drafts/new-draft')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    const row = await prisma.noteDraft.findUniqueOrThrow({
      where: {
        ownerID_clientDraftID: { ownerID: user.id, clientDraftID: 'new-draft' },
      },
    });
    expect(row.consumedAt).toBeInstanceOf(Date);
    expect(row.content).toBeNull();
    expect(row.title).toBe('');
    expect(row.mediaKeys).toEqual([]);
    expect(row.publishedNoteID).toBe(body(published).id);
  });

  it.each(['delete', 'update'] as const)(
    'rejects an autosave validated after %s has consumed the draft',
    async (action) => {
      const { http, token, service, prisma, user } = await account();
      const created = await http
        .post('/api/v1/note')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Original', media: [] })
        .expect(201);
      const id = (created.body.data ?? created.body).id as string;
      const sourceNoteId = action === 'update' ? id : undefined;
      await service.saveNoteDraft(user.id, 'race-draft', {
        sourceNoteId,
        title: 'Earlier',
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const validation = jest
        .spyOn(service as any, 'requireOwnedGroups')
        .mockReturnValueOnce(gate);
      const saving = service.saveNoteDraft(user.id, 'race-draft', {
        sourceNoteId,
        title: 'Late autosave',
      });
      const rejection =
        expect(saving).rejects.toBeInstanceOf(ConflictException);
      try {
        if (action === 'delete')
          await http
            .delete('/api/v1/note/drafts/race-draft')
            .set('Authorization', `Bearer ${token}`)
            .expect(204);
        else
          await http
            .patch(`/api/v1/note/${id}`)
            .set('Authorization', `Bearer ${token}`)
            .send({ title: 'Updated', media: [], clientDraftID: 'race-draft' })
            .expect(200);
      } finally {
        release();
        validation.mockRestore();
      }
      await rejection;
      expect(
        await prisma.noteDraft.count({
          where: {
            ownerID: user.id,
            clientDraftID: 'race-draft',
            consumedAt: null,
          },
        }),
      ).toBe(0);
      if (action === 'update') {
        await service.saveNoteDraft(user.id, 'fresh-edit-draft', {
          sourceNoteId: id,
          title: 'Next edit',
        });
        await http
          .patch(`/api/v1/note/${id}`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            title: 'Next saved',
            media: [],
            clientDraftID: 'fresh-edit-draft',
          })
          .expect(200);
      }
    },
  );

  it('rejects a draft for a different source without changing the note or the draft', async () => {
    const { http, token, service, prisma, user } = await account();
    const created = await http
      .post('/api/v1/note')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Original', media: [] })
      .expect(201);
    const id = (created.body.data ?? created.body).id as string;
    await service.saveNoteDraft(user.id, 'edit-draft', {
      sourceNoteId: id,
      title: 'Keep edit',
    });
    await http
      .post('/api/v1/note')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Wrong create', media: [], clientDraftID: 'edit-draft' })
      .expect(400);
    await service.saveNoteDraft(user.id, 'create-draft', { title: 'Keep new' });
    await http
      .patch(`/api/v1/note/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Wrong update', media: [], clientDraftID: 'create-draft' })
      .expect(400);
    expect(
      await prisma.noteDraft.count({
        where: { ownerID: user.id, consumedAt: null },
      }),
    ).toBe(2);
    expect((await prisma.note.findUniqueOrThrow({ where: { id } })).title).toBe(
      'Original',
    );
  });

  it('replaces omitted JSON and clears its media inventory on an actual draft PUT', async () => {
    const context = await account();
    const { http, token, prisma, user } = context;
    const { signer } = mockMedia(context);
    const image = {
      type: 'IMAGE',
      objectKey: `notes/${user.id}/image.jpg`,
      sortOrder: 0,
    };
    await http
      .put('/api/v1/note/drafts/replacement')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Image',
        contentJson: [{ type: 'image', props: image }],
        sections: { media: { items: [image] } },
      })
      .expect(200);
    signer.mockClear();
    const saved = await http
      .put('/api/v1/note/drafts/replacement')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Title only' })
      .expect(200);
    expect(body(saved)).toMatchObject({
      contentJson: null,
      sections: null,
      mediaKeys: [],
      mediaCount: 0,
    });
    const stored = await prisma.noteDraft.findUniqueOrThrow({
      where: {
        ownerID_clientDraftID: {
          ownerID: user.id,
          clientDraftID: 'replacement',
        },
      },
    });
    expect(stored.contentJson).toBeNull();
    expect(stored.sections).toBeNull();
    expect(stored.mediaKeys).toEqual([]);
    expect(signer).not.toHaveBeenCalled();
  });

  it('reads legacy nested media without signing keys outside its authorized inventory', async () => {
    const context = await account();
    const { http, token, prisma, user } = context;
    const { base, signer } = mockMedia(context);
    const ownKey = `notes/${user.id}/video.mp4`;
    const foreignKey = 'notes/another-owner/private.jpg';
    const blocks = [
      {
        type: 'paragraph',
        children: [
          {
            type: 'video',
            props: {
              objectKey: ownKey,
              posterUrl: `${base}/${foreignKey}`,
            },
          },
        ],
      },
    ];
    await prisma.noteDraft.create({
      data: {
        ownerID: user.id,
        clientDraftID: 'legacy-poster',
        contentJson: blocks,
        mediaKeys: [ownKey],
      },
    });
    const draft = await http
      .get('/api/v1/note/drafts/legacy-poster')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(body(draft).contentJson[0].children[0].props.url).toBe(
      `https://signed.test/${ownKey}?signature=fresh`,
    );
    expect(signer.mock.calls.map(([key]) => key)).toEqual([ownKey]);

    for (const type of ['image', 'video'] as const) {
      for (const expired of [true, false]) {
        signer.mockClear();
        const objectKey = `notes/${user.id}/${type}-${expired}.file`;
        const url = `${base}/${objectKey}`;
        const inline = [
          {
            type: 'paragraph',
            children: [
              {
                type,
                props: {
                  objectKey,
                  ...(expired ? { url: `${url}?signature=expired` } : {}),
                },
              },
              { type: 'image', props: { objectKey: foreignKey } },
            ],
          },
        ];
        const note = await prisma.note.create({
          data: {
            ownerID: user.id,
            title: 'Legacy inline',
            contentJson: inline,
            sections: { text: { contentJson: inline } },
            media: {
              create: {
                type: type === 'image' ? 'IMAGE' : 'VIDEO',
                objectKey,
                url,
                sortOrder: 0,
              },
            },
          },
        });
        const detail = await http
          .get(`/api/v1/note/${note.id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
        const signed = `https://signed.test/${objectKey}?signature=fresh`;
        expect(body(detail).contentJson[0].children[0].props.url).toBe(signed);
        expect(
          body(detail).sections.text.contentJson[0].children[0].props.url,
        ).toBe(signed);
        expect(
          body(detail).sections.text.contentJson[0].children[1].props.url,
        ).toBeFalsy();
        expect(signer.mock.calls.map(([key]) => key)).toEqual([objectKey]);
      }
    }
  });

  it('keeps the canonical circleId through legacy group resolution, persistence, and GET', async () => {
    const { http, token, prisma, user } = await account();
    const groupID = `legacy-${randomUUID()}`;
    const circle = await prisma.circle.create({
      data: {
        ownerID: user.id,
        groupID,
        name: 'Canonical group',
      },
    });
    const saved = await http
      .post('/api/v1/note')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Group card',
        media: [],
        sections: { groups: { items: [{ id: groupID, name: 'Untrusted' }] } },
      })
      .expect(201);
    const id = body(saved).id;
    const expected = {
      id: groupID,
      circleId: circle.id,
      name: 'Canonical group',
      faceURL: null,
    };
    expect(body(saved).sections.groups.items).toEqual([expected]);
    const stored = await prisma.note.findUniqueOrThrow({ where: { id } });
    expect((stored.sections as any).groups.items).toEqual([expected]);
    const detail = await http
      .get(`/api/v1/note/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(body(detail).sections.groups.items).toEqual([expected]);
  });

  it.each(['create', 'update'] as const)(
    'replays a committed %s after signing fails, including after editor draft cleanup',
    async (action) => {
      const context = await account();
      const { http, token, prisma, user, service } = context;
      const { signer } = mockMedia(context);
      let id: string | undefined;
      if (action === 'update') {
        const original = await http
          .post('/api/v1/note')
          .set('Authorization', `Bearer ${token}`)
          .send({ title: 'Original', media: [] })
          .expect(201);
        id = body(original).id;
      }
      await service.saveNoteDraft(user.id, 'replay', {
        title: 'Draft',
        sourceNoteId: id,
      });
      const input = {
        title: 'Saved once',
        clientDraftID: 'replay',
        media: [
          {
            type: 'IMAGE',
            objectKey: `notes/${user.id}/replay.jpg`,
            sortOrder: 0,
          },
        ],
      };
      const save = publicationRequest(context, action, id, input);
      signer.mockRejectedValueOnce(new Error('Signing unavailable'));
      await save().expect(503);
      const outcome = await prisma.noteDraft.findUniqueOrThrow({
        where: {
          ownerID_clientDraftID: { ownerID: user.id, clientDraftID: 'replay' },
        },
      });
      expect(outcome.consumedAt).toBeInstanceOf(Date);
      expect(outcome.publishedNoteID).toBeTruthy();
      if (id) expect(outcome.publishedNoteID).toBe(id);
      const committed = await prisma.note.findUniqueOrThrow({
        where: { id: outcome.publishedNoteID! },
        include: { media: true },
      });
      const responses = await Promise.all([save(), save()]);
      for (const replay of responses) {
        expect(replay.status).toBe(action === 'create' ? 201 : 200);
        expect(body(replay).id).toBe(outcome.publishedNoteID);
      }
      await http
        .delete('/api/v1/note/drafts/replay')
        .set('Authorization', `Bearer ${token}`)
        .expect(204);
      const marker = await prisma.noteDraft.findUniqueOrThrow({
        where: { id: outcome.id },
      });
      expect(marker.publishedNoteID).toBe(outcome.publishedNoteID);
      expect(
        body(await save().expect(action === 'create' ? 201 : 200)).id,
      ).toBe(outcome.publishedNoteID);
      const after = await prisma.note.findUniqueOrThrow({
        where: { id: committed.id },
        include: { media: true },
      });
      expect(after.updatedAt).toEqual(committed.updatedAt);
      expect(after.media.map((item) => item.id)).toEqual(
        committed.media.map((item) => item.id),
      );
      expect(await prisma.note.count({ where: { ownerID: user.id } })).toBe(1);
    },
  );

  it.each(['create', 'update'] as const)(
    'serializes simultaneous %s publications of the same draft',
    async (action) => {
      const context = await account();
      const { http, token, prisma, user, service } = context;
      mockMedia(context);
      let id: string | undefined;
      if (action === 'update') {
        const original = await http
          .post('/api/v1/note')
          .set('Authorization', `Bearer ${token}`)
          .send({ title: 'Original', media: [] })
          .expect(201);
        id = body(original).id;
      }
      await service.saveNoteDraft(user.id, 'simultaneous', {
        sourceNoteId: id,
        title: 'Draft',
      });
      const input = {
        title: 'Committed once',
        media: [
          {
            type: 'IMAGE',
            objectKey: `notes/${user.id}/simultaneous.jpg`,
            sortOrder: 0,
          },
        ],
        clientDraftID: 'simultaneous',
      };
      const save = publicationRequest(context, action, id, input);
      const [first, second] = await Promise.all([save(), save()]);
      expect(first.status).toBe(action === 'create' ? 201 : 200);
      expect(second.status).toBe(action === 'create' ? 201 : 200);
      expect(body(first).id).toBe(body(second).id);
      expect(body(first).media[0].id).toBe(body(second).media[0].id);
      expect(await prisma.note.count({ where: { ownerID: user.id } })).toBe(1);
      expect(
        await prisma.noteMedia.count({ where: { noteID: body(first).id } }),
      ).toBe(1);
      const marker = await prisma.noteDraft.findUniqueOrThrow({
        where: {
          ownerID_clientDraftID: {
            ownerID: user.id,
            clientDraftID: 'simultaneous',
          },
        },
      });
      expect(marker.publishedNoteID).toBe(body(first).id);
    },
  );

  it('rejects discarded, wrong-owner, wrong-source, and deleted-note replays while retaining publication outcomes', async () => {
    const owner = await account();
    const other = await account();
    const { http, token, prisma, user, service } = owner;
    await service.saveNoteDraft(user.id, 'discarded', { title: 'Discard me' });
    await http
      .delete('/api/v1/note/drafts/discarded')
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    await http
      .post('/api/v1/note')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Late publish', media: [], clientDraftID: 'discarded' })
      .expect(409);
    const original = await http
      .post('/api/v1/note')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Original', media: [] })
      .expect(201);
    const id = body(original).id;
    await service.saveNoteDraft(user.id, 'edit', {
      title: 'Edit',
      sourceNoteId: id,
    });
    const input = { title: 'Saved edit', media: [], clientDraftID: 'edit' };
    await http
      .patch(`/api/v1/note/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send(input)
      .expect(200);
    await other.http
      .patch(`/api/v1/note/${id}`)
      .set('Authorization', `Bearer ${other.token}`)
      .send(input)
      .expect(404);
    await http
      .patch(`/api/v1/note/${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`)
      .send(input)
      .expect(409);
    await http
      .post('/api/v1/note')
      .set('Authorization', `Bearer ${token}`)
      .send(input)
      .expect(409);
    await http
      .delete(`/api/v1/note/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    await http
      .patch(`/api/v1/note/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send(input)
      .expect(404);
    await prisma.note.delete({ where: { id } });
    const marker = await prisma.noteDraft.findUniqueOrThrow({
      where: {
        ownerID_clientDraftID: { ownerID: user.id, clientDraftID: 'edit' },
      },
    });
    expect(marker.publishedNoteID).toBe(id);
    expect(marker.sourceNoteID).toBeNull();
    await http
      .post('/api/v1/note')
      .set('Authorization', `Bearer ${token}`)
      .send(input)
      .expect(404);
    expect(await prisma.note.count({ where: { ownerID: user.id } })).toBe(0);
  });
});
