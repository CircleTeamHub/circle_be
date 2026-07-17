import { CircleInvitationController } from './circle-invitation.controller';

describe('CircleInvitationController pagination', () => {
  it('forwards list cursors and limits with the authenticated scope', async () => {
    const service = {
      getMyPendingVerifications: jest.fn().mockResolvedValue([]),
      getMyApplications: jest.fn().mockResolvedValue([]),
      getPendingInvitationsForCircle: jest.fn().mockResolvedValue([]),
    };
    const controller = new CircleInvitationController(service as any);
    const request = { user: { userId: 'user-1' } } as any;
    const query = {
      cursor: '11111111-1111-4111-8111-111111111111',
      limit: 25,
    };

    await controller.myPendingVerifications(request, query);
    await controller.myApplications(request, query);
    await controller.circlePending('circle-1', request, query);

    expect(service.getMyPendingVerifications).toHaveBeenCalledWith(
      'user-1',
      query,
    );
    expect(service.getMyApplications).toHaveBeenCalledWith('user-1', query);
    expect(service.getPendingInvitationsForCircle).toHaveBeenCalledWith(
      'user-1',
      'circle-1',
      query,
    );
  });
});
