import { reserveCircleSeats } from './circle-capacity';

describe('reserveCircleSeats', () => {
  it('atomically increments the counter only when all requested seats fit', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'circle-1' }]),
    };

    await expect(
      reserveCircleSeats(tx as any, 'circle-1', 2, 100),
    ).resolves.toBe(true);

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const [sql, ...values] = tx.$queryRaw.mock.calls[0];
    expect(sql.join(' ')).toContain('UPDATE "Circle"');
    expect(sql.join(' ')).toContain('"deleted" = false');
    expect(sql.join(' ')).toContain('"memberCount" +   <= "maxMembers"');
    expect(sql.join(' ')).toContain('RETURNING "id"');
    // seatCount 出现在 SET、maxMembers 从句、owner-cap 从句共 3 次；circleId 与 ownerCapacity 各 1 次。
    expect(values).toEqual([2, 'circle-1', 2, 2, 100]);
  });

  it('also caps the reservation by the owner effective capacity', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'circle-1' }]),
    };

    await expect(reserveCircleSeats(tx as any, 'circle-1', 1, 50)).resolves.toBe(
      true,
    );
    // ownerCapacity 作为独立上限并入 WHERE（末位插值），legacy null maxMembers 也被它封顶。
    const values = tx.$queryRaw.mock.calls[0].slice(1);
    expect(values[values.length - 1]).toBe(50);
  });

  it('reports a failed reservation when the conditional update changes no row', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) };

    await expect(
      reserveCircleSeats(tx as any, 'circle-1', 1, 100),
    ).resolves.toBe(false);
  });

  it('does not query the database for an empty reservation', async () => {
    const tx = { $queryRaw: jest.fn() };

    await expect(
      reserveCircleSeats(tx as any, 'circle-1', 0, 100),
    ).resolves.toBe(true);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('rejects invalid seat counts', async () => {
    const tx = { $queryRaw: jest.fn() };

    await expect(
      reserveCircleSeats(tx as any, 'circle-1', -1, 100),
    ).rejects.toThrow('seatCount must be a non-negative safe integer');
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('rejects an invalid owner capacity', async () => {
    const tx = { $queryRaw: jest.fn() };

    await expect(
      reserveCircleSeats(tx as any, 'circle-1', 1, -1),
    ).rejects.toThrow('ownerCapacity must be a non-negative safe integer');
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
