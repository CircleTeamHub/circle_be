import { reserveCircleSeats } from './circle-capacity';

describe('reserveCircleSeats', () => {
  it('atomically increments the counter only when all requested seats fit', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'circle-1' }]),
    };

    await expect(reserveCircleSeats(tx as any, 'circle-1', 2)).resolves.toBe(
      true,
    );

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const [sql, ...values] = tx.$queryRaw.mock.calls[0];
    expect(sql.join(' ')).toContain('UPDATE "Circle"');
    expect(sql.join(' ')).toContain('"memberCount" +   <= "maxMembers"');
    expect(sql.join(' ')).toContain('RETURNING "id"');
    expect(values).toEqual([2, 'circle-1', 2]);
  });

  it('reports a failed reservation when the conditional update changes no row', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) };

    await expect(reserveCircleSeats(tx as any, 'circle-1', 1)).resolves.toBe(
      false,
    );
  });

  it('does not query the database for an empty reservation', async () => {
    const tx = { $queryRaw: jest.fn() };

    await expect(reserveCircleSeats(tx as any, 'circle-1', 0)).resolves.toBe(
      true,
    );
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('rejects invalid seat counts', async () => {
    const tx = { $queryRaw: jest.fn() };

    await expect(reserveCircleSeats(tx as any, 'circle-1', -1)).rejects.toThrow(
      'seatCount must be a non-negative safe integer',
    );
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
