var server = require('../src/server');
var db = require('../src/models/db');

var chai = require('chai');
var chaiHttp = require('chai-http');
var should = chai.should();

chai.use(chaiHttp);

function validateGraphQLResponse(res) {
    res.should.have.status(200);
    res.body.should.not.have.any.keys("errors");
    res.body.should.have.all.keys("data");
}

describe('server', function () {
    before(function() {
        db.loadFromFile('test/server.data.json');
    });

    it('GET /sha256 returns a valid sha256', function (done) {
        chai.request(server)
            .get('/sha256')
            .end(function (err, res) {
                res.text.length.should.equal(64);
                done();
            });
    });

    it("resolves item refs", function (done) {
        var query = `{
            role {
                name
                permissions {
                    service
                }
            }
        }`;

        chai.request(server)
        .get('/graphql')
        .query({'query': query})
        .end(function (err, res) {
            validateGraphQLResponse(res);
            var permissionsName = res.body.data.role[0].permissions[0].service;
            permissionsName.should.equal("github-org-team");
            done();
        });
    });

    it("resolves object refs", function (done) {
        var query = `{
            app {
                quayRepos {
                    org {
                        name
                    }
                }
            }
        }`;

        chai.request(server)
        .get('/graphql')
        .query({'query': query})
        .end(function (err, res) {
            validateGraphQLResponse(res);
            var org_response = res.body.data.app[0].quayRepos[0].org.name;
            org_response.should.equal("quay-org-A");
            done();
        });
    });
});
