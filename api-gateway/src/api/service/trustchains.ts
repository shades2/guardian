import { Guardians } from '@helpers/guardians';
import { Response, Router } from 'express';
import { UserRole } from 'interfaces';
import { AuthenticatedRequest, IAuthUser } from '@auth/auth.interface';
import { permissionHelper } from '@auth/authorizationHelper';
import { Users } from '@helpers/users';

/**
 * Audit route
 */
export const trustchainsAPI = Router();

trustchainsAPI.get('/', permissionHelper(UserRole.AUDITOR), async (req: AuthenticatedRequest, res: Response) => {
    try {
        const guardians = new Guardians();
        const vp = await guardians.getVpDocuments();
        res.status(200).json(vp);
    } catch (error) {
        res.status(500).json({ code: 500, message: error.message });
    }
});

trustchainsAPI.get('/:hash', permissionHelper(UserRole.AUDITOR), async (req: AuthenticatedRequest, res: Response) => {
    try {
        const guardians = new Guardians();
        const hash = req.params.hash;
        const chain = await guardians.getChain(hash);
        const DIDs = chain.map((item) => {
            if (item.type === 'VC' && item.document) {
                return item.document.issuer;
            }
            if (item.type === 'DID') {
                return item.id;
            }
            return null;
        }).filter(did => !!did);

        const users = new Users();

        let userMap: any = users.getUsersByIds(DIDs) || [];
        userMap = userMap.map((user: IAuthUser) => {
            return { username: user.username, did: user.did }
        })

        res.status(200).json({ chain, userMap });
    } catch (error) {
        res.status(500).json({ code: 500, message: error.message });
    }
});